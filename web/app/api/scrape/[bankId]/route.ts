export const dynamic = "force-dynamic";
export const maxDuration = 300;

import chromium from "@sparticuz/chromium";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { decrypt } from "@/lib/credentials";
import { movementHash } from "@/lib/hash";
import { getBank } from "open-banking-chile";

type Phase = 1 | 2 | 3 | 4 | 5;

function stringToPhase(msg: string): Phase {
  const m = msg.toLowerCase();
  if (m.includes("abriendo") || m.includes("navegando") || m.includes("conectando") || m.includes("opening")) return 1;
  if (m.includes("login") || m.includes("autenti") || m.includes("credencial") || m.includes("ingresando") || m.includes("submitting")) return 2;
  if (m.includes("extray") || m.includes("movimiento") || m.includes("listo") || m.includes("extracting")) return 3;
  return 4;
}

export async function GET(req: Request, { params }: { params: Promise<{ bankId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const { bankId } = await params;
  const userId = session.user.id;

  const bank = getBank(bankId);
  if (!bank) return new Response("Bank not found", { status: 404 });

  const encoder = new TextEncoder();
  let keepaliveInterval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream may already be closed
        }
      };

      const keepalive = () => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // ignore
        }
      };

      keepaliveInterval = setInterval(keepalive, 20_000);

      try {
        // Atomically acquire sync lock via RPC
        const { data: acquired, error: lockError } = await supabase.rpc("acquire_sync_lock", {
          p_user_id: userId,
          p_bank_id: bankId,
        });

        if (lockError || !acquired) {
          send({ phase: 1, error: true, message: "Ya hay una sincronización en curso para este banco." });
          controller.close();
          return;
        }

        // Fetch and decrypt credentials — always scoped to this user
        const { data: cred } = await supabase
          .from("bank_credentials")
          .select("encrypted_rut, rut_iv, encrypted_password, password_iv")
          .eq("user_id", userId)
          .eq("bank_id", bankId)
          .single();

        if (!cred) {
          await supabase
            .from("bank_credentials")
            .update({ is_syncing: false })
            .eq("user_id", userId)
            .eq("bank_id", bankId);
          send({ phase: 1, error: true, message: "No se encontraron credenciales para este banco." });
          controller.close();
          return;
        }

        const rut = await decrypt(cred.encrypted_rut, cred.rut_iv);
        const password = await decrypt(cred.encrypted_password, cred.password_iv);

        send({ phase: 1, label: "Iniciando conexión", message: "Abriendo sesión segura" });

        const chromePath = await chromium.executablePath();

        const result = await bank.scrape({
          rut,
          password,
          chromePath,
          onProgress: (msg: string) => {
            const phase = stringToPhase(msg);
            const labels: Record<Phase, string> = {
              1: "Iniciando conexión",
              2: "Autenticando",
              3: "Extrayendo movimientos",
              4: "Procesando datos",
              5: "Completado",
            };
            send({ phase, label: labels[phase], message: msg });
          },
        });

        if (!result.success) {
          send({ phase: 2, error: true, message: result.error ?? "Error desconocido al scrapear el banco." });
          return;
        }

        send({ phase: 4, label: "Procesando datos", message: "Guardando movimientos..." });

        // Upsert movements — conflict on hash is a no-op (deduplication)
        let inserted = 0;
        for (const m of result.movements) {
          const hash = movementHash(userId, bankId, m.date, m.description, m.amount);
          const { data: rows } = await supabase
            .from("movements")
            .upsert(
              {
                user_id: userId,
                bank_id: bankId,
                date: m.date,
                description: m.description,
                amount: String(m.amount),
                balance: m.balance != null ? String(m.balance) : null,
                source: m.source,
                hash,
              },
              { onConflict: "hash", ignoreDuplicates: true },
            )
            .select("id");
          inserted += (rows ?? []).length;
        }

        await supabase
          .from("bank_credentials")
          .update({ is_syncing: false, last_synced_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("bank_id", bankId);

        send({ phase: 5, label: "Completado", message: `${inserted} movimientos nuevos sincronizados`, done: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado";
        console.error(`[scrape:${bankId}]`, message);
        send({
          phase: 2,
          error: true,
          message: "No se pudo completar la sincronizacion. Reintenta en unos minutos.",
        });
      } finally {
        clearInterval(keepaliveInterval);
        supabase
          .from("bank_credentials")
          .update({ is_syncing: false })
          .eq("user_id", userId)
          .eq("bank_id", bankId)
          .then(() => {}, () => {}); // best-effort reset
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
