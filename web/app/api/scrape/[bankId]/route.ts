export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/credentials";
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
        // Auto-release stale locks older than 5 minutes (from crashed/timed-out functions)
        await supabase
          .from("bank_credentials")
          .update({ is_syncing: false })
          .eq("user_id", userId)
          .eq("bank_id", bankId)
          .eq("is_syncing", true)
          .lt("last_synced_at", new Date(Date.now() - 5 * 60_000).toISOString());

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
        const { data: cred, error: credError } = await supabase
          .from("bank_credentials")
          .select("encrypted_rut, rut_iv, encrypted_password, password_iv")
          .eq("user_id", userId)
          .eq("bank_id", bankId)
          .single();

        if (credError || !cred) {
          console.error("[scrape] credential lookup failed:", credError, "userId:", userId, "bankId:", bankId);
          await supabase
            .from("bank_credentials")
            .update({ is_syncing: false })
            .eq("user_id", userId)
            .eq("bank_id", bankId);
          send({ phase: 1, error: true, message: "No se encontraron credenciales para este banco." });
          controller.close();
          return;
        }

        // Session cookies are optional (column may not exist yet)
        let sessionCookies: string | null = null;
        try {
          const { data: cookieRow } = await supabase
            .from("bank_credentials")
            .select("encrypted_cookies, cookies_iv")
            .eq("user_id", userId)
            .eq("bank_id", bankId)
            .single();
          if (cookieRow?.encrypted_cookies && cookieRow?.cookies_iv) {
            sessionCookies = await decrypt(cookieRow.encrypted_cookies, cookieRow.cookies_iv);
          }
        } catch {
          // cookies columns may not exist — not critical
        }

        const rut = await decrypt(cred.encrypted_rut, cred.rut_iv);
        const password = await decrypt(cred.encrypted_password, cred.password_iv);

        send({ phase: 1, label: "Iniciando conexión", message: "Abriendo sesión segura" });

        // API-mode scrapers (e.g. Fintual) use fetch() — skip Chromium initialization
        const needsBrowser = bank.mode !== "api";

        let chromePath: string | undefined;
        let launchArgs: string[] | undefined;
        if (needsBrowser) {
          // Dynamic import — only load @sparticuz/chromium when a browser is needed.
          // This avoids the ~45s cold-start penalty for API-mode scrapers.
          const chromium = (await import("@sparticuz/chromium")).default;
          chromePath = await chromium.executablePath();
          launchArgs = chromium.args.filter(
            (a: string) => !a.startsWith("--headless"),
          );
          launchArgs.push("--headless=shell");
        }

        // Load stored browser cookies (if any) — avoids 2FA on repeat runs
        const storedCookiesJson: string | undefined = sessionCookies ?? undefined;

        // 2FA code exchange: SSE signals the frontend, which POSTs the code to a Supabase row.
        // The onTwoFactorCode callback polls for up to 90s (matching typical bank code TTL).
        const onTwoFactorCode = async (): Promise<string> => {
          send({ phase: 2, requires_2fa: true, label: "Verificación requerida", message: "El banco solicita un código de verificación. Ingresa el código que recibiste." });
          const deadline = Date.now() + 90_000;
          while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            const { data: row } = await supabase
              .from("pending_2fa")
              .select("code")
              .eq("user_id", userId)
              .eq("bank_id", bankId)
              .single();
            if (row?.code) {
              await supabase.from("pending_2fa").delete().eq("user_id", userId).eq("bank_id", bankId);
              return row.code as string;
            }
          }
          return "";
        };

        const result = await bank.scrape({
          rut,
          password,
          ...(chromePath ? { chromePath } : {}),
          ...(launchArgs ? { launchArgs } : {}),
          onTwoFactorCode,
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

        // Persist session cookies so the next sync skips 2FA
        if (result.success && result.sessionCookies) {
          try {
            const { ciphertext, iv } = await encrypt(result.sessionCookies);
            await supabase
              .from("bank_credentials")
              .update({ encrypted_cookies: ciphertext, cookies_iv: iv })
              .eq("user_id", userId)
              .eq("bank_id", bankId);
          } catch { /* non-fatal */ }
        }

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
        // Must await — fire-and-forget may not execute before Vercel kills the function
        try {
          await supabase
            .from("bank_credentials")
            .update({ is_syncing: false })
            .eq("user_id", userId)
            .eq("bank_id", bankId);
        } catch { /* best-effort */ }
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
