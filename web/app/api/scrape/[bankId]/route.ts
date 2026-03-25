export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bankCredentials, movements } from "@/lib/schema";
import { decrypt } from "@/lib/credentials";
import { movementHash } from "@/lib/hash";
import { getBank } from "open-banking-chile";
import { and, eq, lt, or, sql } from "drizzle-orm";

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
        // Atomically acquire lock (handles stale locks older than 10 min)
        const locked = await db.execute(sql`
          UPDATE bank_credentials
          SET is_syncing = true
          WHERE user_id = ${userId}
            AND bank_id = ${bankId}
            AND (is_syncing = false OR last_synced_at < now() - interval '10 minutes')
          RETURNING id
        `);

        if (!locked.rows.length) {
          send({ phase: 1, error: true, message: "Ya hay una sincronización en curso para este banco." });
          controller.close();
          return;
        }

        // Fetch and decrypt credentials — always scoped to this user
        const cred = await db.query.bankCredentials.findFirst({
          where: and(eq(bankCredentials.userId, userId), eq(bankCredentials.bankId, bankId)),
        });

        if (!cred) {
          await db
            .update(bankCredentials)
            .set({ isSyncing: false })
            .where(and(eq(bankCredentials.userId, userId), eq(bankCredentials.bankId, bankId)));
          send({ phase: 1, error: true, message: "No se encontraron credenciales para este banco." });
          controller.close();
          return;
        }

        const rut = await decrypt(cred.encryptedRut, cred.rutIv);
        const password = await decrypt(cred.encryptedPassword, cred.passwordIv);

        send({ phase: 1, label: "Iniciando conexión", message: "Abriendo sesión segura" });

        const result = await bank.scrape({
          rut,
          password,
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

        // Upsert movements — conflict on hash is a no-op (known trade-off for same-day duplicates)
        let inserted = 0;
        for (const m of result.movements) {
          const hash = movementHash(userId, bankId, m.date, m.description, m.amount);
          const rows = await db
            .insert(movements)
            .values({
              userId,
              bankId,
              date: m.date,
              description: m.description,
              amount: String(m.amount),
              balance: m.balance != null ? String(m.balance) : null,
              source: m.source,
              hash,
            })
            .onConflictDoNothing()
            .returning({ id: movements.id });
          inserted += rows.length;
        }

        await db
          .update(bankCredentials)
          .set({ isSyncing: false, lastSyncedAt: new Date() })
          .where(and(eq(bankCredentials.userId, userId), eq(bankCredentials.bankId, bankId)));

        send({ phase: 5, label: "Completado", message: `${inserted} movimientos nuevos sincronizados`, done: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado";
        send({ phase: 2, error: true, message });
      } finally {
        clearInterval(keepaliveInterval);
        await db
          .update(bankCredentials)
          .set({ isSyncing: false })
          .where(and(eq(bankCredentials.userId, userId), eq(bankCredentials.bankId, bankId)))
          .catch(() => {}); // best-effort reset
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
