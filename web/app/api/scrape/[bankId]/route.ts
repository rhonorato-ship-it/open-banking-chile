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

/** Hard timeout for the entire scrape operation. Leaves 25s headroom under Vercel's 300s limit. */
const SCRAPE_TIMEOUT_MS = 275_000;

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
      let terminated = false;

      /** Send an SSE event. No-ops if stream is already closed. */
      const send = (data: object) => {
        if (terminated) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          terminated = true;
        }
      };

      /** Send a terminal event (done or error) and close the stream. Idempotent. */
      const terminate = (data: object) => {
        send(data);
        terminated = true;
        clearInterval(keepaliveInterval);
        try { controller.close(); } catch { /* already closed */ }
      };

      /** Reset the sync lock in the DB. Must be awaited. */
      const releaseLock = async () => {
        try {
          await supabase
            .from("bank_credentials")
            .update({ is_syncing: false })
            .eq("user_id", userId)
            .eq("bank_id", bankId);
        } catch { /* best-effort */ }
      };

      // Keepalives as real SSE data events so the client's onmessage handler can reset its inactivity timer.
      // SSE comments (": keepalive\n\n") are silently consumed by EventSource and never fire onmessage.
      keepaliveInterval = setInterval(() => {
        if (terminated) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ keepalive: true })}\n\n`)); } catch { terminated = true; }
      }, 20_000);

      try {
        // ── Lock acquisition ─────────────────────────────────────
        // Force-release any stuck lock (from crashed/timed-out previous functions)
        await releaseLock();

        const { data: acquired, error: lockError } = await supabase.rpc("acquire_sync_lock", {
          p_user_id: userId,
          p_bank_id: bankId,
        });

        if (lockError || !acquired) {
          terminate({ phase: 1, error: true, message: "No se pudo iniciar la sincronización. Reintenta." });
          return;
        }

        // ── Credentials ──────────────────────────────────────────
        const { data: cred, error: credError } = await supabase
          .from("bank_credentials")
          .select("encrypted_rut, rut_iv, encrypted_password, password_iv")
          .eq("user_id", userId)
          .eq("bank_id", bankId)
          .single();

        if (credError || !cred) {
          console.error(`[scrape:${bankId}] credential lookup failed:`, credError);
          terminate({ phase: 1, error: true, message: "No se encontraron credenciales para este banco." });
          return;
        }

        // Session cookies (optional — column may not exist)
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
        } catch { /* not critical */ }

        const rut = await decrypt(cred.encrypted_rut, cred.rut_iv);
        const password = await decrypt(cred.encrypted_password, cred.password_iv);

        send({ phase: 1, label: "Iniciando conexión", message: "Abriendo sesión segura" });

        // ── Browser setup (only for non-API scrapers) ────────────
        const needsBrowser = bank.mode !== "api";
        let chromePath: string | undefined;
        let launchArgs: string[] | undefined;
        if (needsBrowser) {
          const chromium = (await import("@sparticuz/chromium")).default;
          chromePath = await chromium.executablePath();
          launchArgs = chromium.args.filter((a: string) => !a.startsWith("--headless"));
          launchArgs.push("--headless=shell");
        }

        // ── 2FA callback ─────────────────────────────────────────
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

        // ── Scrape with hard timeout ─────────────────────────────
        const scrapePromise = bank.scrape({
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

        let scrapeTimerId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          scrapeTimerId = setTimeout(() => reject(new Error("SCRAPE_TIMEOUT")), SCRAPE_TIMEOUT_MS);
        });

        let result;
        try {
          result = await Promise.race([scrapePromise, timeoutPromise]);
        } finally {
          if (scrapeTimerId) clearTimeout(scrapeTimerId);
        }

        // ── Persist session cookies ──────────────────────────────
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
          terminate({ phase: 2, error: true, message: result.error ?? "Error desconocido al scrapear el banco." });
          return;
        }

        // ── Store movements ──────────────────────────────────────
        send({ phase: 4, label: "Procesando datos", message: "Guardando movimientos..." });

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

        // ── Success ──────────────────────────────────────────────
        await supabase
          .from("bank_credentials")
          .update({ is_syncing: false, last_synced_at: new Date().toISOString() })
          .eq("user_id", userId)
          .eq("bank_id", bankId);

        terminate({ phase: 5, label: "Completado", message: `${inserted} movimientos nuevos sincronizados`, done: true });

      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado";
        console.error(`[scrape:${bankId}]`, message);

        const userMessage = message === "SCRAPE_TIMEOUT"
          ? "La sincronización tardó demasiado y fue cancelada. Reintenta."
          : "No se pudo completar la sincronización. Reintenta en unos minutos.";

        terminate({ phase: 2, error: true, message: userMessage });

      } finally {
        // Guaranteed lock release — runs even if terminate() was already called
        clearInterval(keepaliveInterval);
        await releaseLock();
        if (!terminated) {
          // Safety net: if somehow we got here without sending a terminal event
          terminate({ phase: 2, error: true, message: "Error inesperado. Reintenta." });
        }
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
