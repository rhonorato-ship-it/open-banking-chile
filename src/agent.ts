#!/usr/bin/env node
/**
 * Local sync agent for open-banking-chile.
 *
 * Entry point: `npx open-banking-chile serve`
 *
 * The agent authenticates to Supabase with a bearer token, announces its
 * presence via heartbeats, and listens for sync_tasks via Realtime.  When a
 * task arrives it claims it, runs the bank scraper, uploads movements (with
 * SHA-256 hash dedup), and marks the task done.
 *
 * Credentials are fetched from the dashboard API (no local env vars needed).
 * Falls back to env vars if the API is unreachable.
 */

import { config } from "dotenv";
import { createHash, randomUUID } from "node:crypto";
import * as readline from "node:readline";
import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import { loadConfig, saveConfig, createAgentSupabase } from "./agent-auth.js";
import { banks, getBank, listBanks } from "./index.js";
import type { BankMovement } from "./types.js";

config();

// ─── Constants ────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const TWOFACTOR_POLL_INTERVAL_MS = 2_000;
const TWOFACTOR_TIMEOUT_MS = 90_000;
const DEFAULT_WEB_URL = "https://open-banking-chile.vercel.app";

// ─── Helpers ──────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function warn(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.warn(`[${ts}] WARN: ${msg}`);
}

function movementHash(
  userId: string,
  bankId: string,
  date: string,
  description: string,
  amount: number,
): string {
  return createHash("sha256")
    .update(`${userId}|${bankId}|${date}|${description}|${amount}`)
    .digest("hex");
}

/** Prompt for input on a TTY. */
function promptTTY(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Credential fetching from dashboard API ──────────────────

/**
 * Fetch the list of banks the user has configured in the dashboard.
 * Returns bank IDs (e.g. ["bice", "bchile", "fintual"]).
 */
async function fetchConfiguredBanks(
  token: string,
  webUrl: string,
): Promise<string[]> {
  const res = await fetch(`${webUrl}/api/agent/credentials/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`credentials/list returned ${res.status}`);
  }
  const data = await res.json();
  return data.banks as string[];
}

/**
 * Fetch decrypted credentials for a specific bank from the dashboard API.
 */
async function fetchCredentials(
  token: string,
  webUrl: string,
  bankId: string,
): Promise<{ rut: string; password: string }> {
  const res = await fetch(
    `${webUrl}/api/agent/credentials?bankId=${encodeURIComponent(bankId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`credentials returned ${res.status} for ${bankId}`);
  }
  return (await res.json()) as { rut: string; password: string };
}

/** Detect which banks have credentials configured via env vars (fallback). */
function detectConfiguredBanksFromEnv(): Array<{ id: string; name: string }> {
  const available = listBanks();
  const configured: Array<{ id: string; name: string }> = [];

  for (const bank of available) {
    const prefix = bank.id.toUpperCase();
    const rut = process.env[`${prefix}_RUT`];
    const pass =
      process.env[`${prefix}_PASS`] || process.env[`${prefix}_PASSWORD`];
    if (rut && pass) {
      configured.push({ id: bank.id, name: bank.name });
    }
  }

  return configured;
}

/** Read credentials for a bank from env vars (fallback). */
function readCredentialsFromEnv(
  bankId: string,
): { rut: string; password: string } | null {
  const prefix = bankId.toUpperCase();
  const rut = process.env[`${prefix}_RUT`];
  const password =
    process.env[`${prefix}_PASS`] || process.env[`${prefix}_PASSWORD`];
  if (!rut || !password) return null;
  return { rut, password };
}

// ─── Auto-auth flow ──────────────────────────────────────────

/**
 * Browser-based auth: starts a local callback server, opens the dashboard
 * in the default browser, and waits for the page to deliver the JWT
 * automatically.  No copy/paste required — the user only needs to be logged
 * in on the dashboard.
 *
 * Rejects with Error("timeout") after 5 minutes so the caller can fall back
 * to the manual paste flow.
 */
async function browserAuth(webUrl: string): Promise<string> {
  const { createServer } = await import("node:http");
  const { execFile } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    let settled = false;

    const server = createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      const parsed = new URL(req.url ?? "/", "http://localhost");
      if (parsed.pathname === "/callback") {
        const token = parsed.searchParams.get("token");
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        });
        res.end("ok");

        if (token && !settled) {
          settled = true;
          server.close();
          resolve(token);
        }
      }
    });

    server.on("error", (err) => {
      if (!settled) reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const callbackUrl = `http://127.0.0.1:${addr.port}/callback`;
      const authUrl = `${webUrl}/agent?callback=${encodeURIComponent(callbackUrl)}`;

      console.log("");
      console.log("  Abriendo navegador para autenticacion...");
      console.log(`  Si no se abre automaticamente: ${authUrl}`);
      console.log("");

      // Open browser — execFile avoids shell injection
      if (process.platform === "darwin") {
        execFile("open", [authUrl]);
      } else if (process.platform === "win32") {
        execFile("cmd", ["/c", "start", "", authUrl]);
      } else {
        execFile("xdg-open", [authUrl]);
      }
    });

    // 5-minute timeout → caller falls back to manual paste
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error("timeout"));
      }
    }, 5 * 60 * 1000);

    server.on("close", () => clearTimeout(timer));
  });
}

/**
 * Manual fallback: prompt user to open the dashboard and paste the token.
 */
async function interactiveAuth(webUrl: string): Promise<string> {
  console.log("");
  console.log("  === Autenticacion del agente (manual) ===");
  console.log("");
  console.log(`  1. Abre tu navegador: ${webUrl}/agent`);
  console.log("  2. Genera y copia el token.");
  console.log("  3. Pegalo aqui abajo.");
  console.log("");

  const token = await promptTTY("  Token: ");

  if (!token) {
    console.error("Error: No se ingreso un token.");
    process.exit(1);
  }

  return token;
}

// ─── Core agent ───────────────────────────────────────────────

export async function startAgent(
  token?: string,
  webUrl?: string,
): Promise<void> {
  const resolvedWebUrl = webUrl || DEFAULT_WEB_URL;

  // ── Resolve token ────────────────────────────────────────
  const savedConfig = loadConfig();
  let resolvedToken = token || savedConfig?.token;

  // Auto-auth: browser-based flow works with or without a TTY
  if (!resolvedToken) {
    resolvedToken = await browserAuth(resolvedWebUrl).catch(async (err) => {
      if ((err as Error).message === "timeout") {
        warn("Tiempo de espera agotado.");
      } else {
        warn(`No se pudo abrir el navegador: ${(err as Error).message}`);
      }
      // Fall back to manual paste only when there is an interactive terminal
      if (process.stdin.isTTY) {
        return interactiveAuth(resolvedWebUrl);
      }
      console.error(
        "Error: No se pudo autenticar automaticamente.\n" +
          `  Visita ${resolvedWebUrl}/agent y usa --token <token>.`,
      );
      process.exit(1);
    });
  }

  // Persist token if it was passed via flag or interactive auth
  if (resolvedToken !== savedConfig?.token) {
    saveConfig({
      ...savedConfig,
      token: resolvedToken,
      supabaseUrl: savedConfig?.supabaseUrl,
      supabaseKey: savedConfig?.supabaseKey,
    });
    log("Token saved to config.");
  }

  // ── Create authenticated Supabase client ─────────────────
  const supabase = createAgentSupabase(resolvedToken, {
    supabaseUrl: savedConfig?.supabaseUrl,
    supabaseKey: savedConfig?.supabaseKey,
  });

  // ── Detect configured banks ──────────────────────────────
  // Try the dashboard API first, fall back to env vars
  let configuredBanks: Array<{ id: string; name: string }> = [];
  let credentialSource: "api" | "env" = "api";

  try {
    log("Fetching configured banks from dashboard...");
    const bankIds = await fetchConfiguredBanks(resolvedToken, resolvedWebUrl);
    const allBanks = listBanks();
    configuredBanks = bankIds
      .map((id) => {
        const found = allBanks.find((b) => b.id === id);
        return found ? { id: found.id, name: found.name } : null;
      })
      .filter((b): b is { id: string; name: string } => b !== null);
    log(`Dashboard returned ${configuredBanks.length} bank(s).`);
  } catch (err) {
    warn(
      `Could not fetch banks from dashboard: ${(err as Error).message}. Falling back to env vars.`,
    );
    configuredBanks = detectConfiguredBanksFromEnv();
    credentialSource = "env";
  }

  if (configuredBanks.length === 0) {
    console.error(
      "Error: No bank credentials found.\n" +
        `  Configure your banks at ${resolvedWebUrl}/banks\n` +
        "  Or set <BANK>_RUT and <BANK>_PASS env vars as fallback.",
    );
    process.exit(1);
  }

  log("=== Open Banking Chile — Local Sync Agent ===");
  log(`Agent ID: ${agentId}`);
  log(`Credential source: ${credentialSource}`);
  log(
    `Configured banks: ${configuredBanks.map((b) => b.id).join(", ")} (${configuredBanks.length})`,
  );

  // ── Heartbeat loop ───────────────────────────────────────
  const heartbeat = async () => {
    try {
      await supabase.from("agent_presence").upsert(
        {
          agent_id: agentId,
          banks: configuredBanks.map((b) => b.id),
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "agent_id" },
      );
    } catch (err) {
      warn(`Heartbeat failed: ${(err as Error).message}`);
    }
  };

  // Send initial heartbeat, then start interval
  await heartbeat();
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  log("Heartbeat started (30s interval).");

  // ── Task handler ─────────────────────────────────────────
  const handleTask = async (taskId: string, bankId: string, userId: string) => {
    log(`Task ${taskId}: received for bank=${bankId}, user=${userId}`);

    // Claim the task
    const { data: claimed, error: claimError } = await supabase
      .from("sync_tasks")
      .update({ status: "running", agent_id: agentId })
      .eq("id", taskId)
      .eq("status", "pending")
      .select("id")
      .single();

    if (claimError || !claimed) {
      log(`Task ${taskId}: already claimed by another agent, skipping.`);
      return;
    }

    log(`Task ${taskId}: claimed.`);

    const updateTask = async (fields: Record<string, unknown>) => {
      await supabase.from("sync_tasks").update(fields).eq("id", taskId);
    };

    try {
      // ── Read credentials (API first, env fallback) ────
      let creds: { rut: string; password: string } | null = null;

      if (credentialSource === "api") {
        try {
          creds = await fetchCredentials(resolvedToken, resolvedWebUrl, bankId);
        } catch (err) {
          warn(
            `Task ${taskId}: API credential fetch failed (${(err as Error).message}), trying env vars...`,
          );
        }
      }

      // Fallback to env vars
      if (!creds) {
        creds = readCredentialsFromEnv(bankId);
      }

      if (!creds) {
        await updateTask({
          status: "error",
          error_message: `No credentials found for bank ${bankId}. Configure them at ${resolvedWebUrl}/banks.`,
        });
        warn(`Task ${taskId}: no credentials for ${bankId}.`);
        return;
      }

      const bank = getBank(bankId);
      if (!bank) {
        await updateTask({
          status: "error",
          error_message: `Unknown bank: ${bankId}`,
        });
        warn(`Task ${taskId}: unknown bank ${bankId}.`);
        return;
      }

      // ── 2FA callback ────────────────────────────────────
      const onTwoFactorCode = async (): Promise<string> => {
        // If running in a TTY, prompt the user directly
        if (process.stdin.isTTY) {
          log(`Task ${taskId}: 2FA code required. Prompting on TTY...`);
          const code = await promptTTY(
            `[2FA] ${bank.name} requires a verification code. Enter code: `,
          );
          return code;
        }

        // Non-TTY: signal via sync_tasks and poll pending_2fa
        log(
          `Task ${taskId}: 2FA code required. Setting requires_2fa=true and polling...`,
        );
        await updateTask({ requires_2fa: true });

        const deadline = Date.now() + TWOFACTOR_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, TWOFACTOR_POLL_INTERVAL_MS));
          const { data: row } = await supabase
            .from("pending_2fa")
            .select("code")
            .eq("user_id", userId)
            .eq("bank_id", bankId)
            .single();

          if (row?.code) {
            // Clean up the row
            await supabase
              .from("pending_2fa")
              .delete()
              .eq("user_id", userId)
              .eq("bank_id", bankId);
            log(`Task ${taskId}: 2FA code received.`);
            return row.code as string;
          }
        }

        warn(`Task ${taskId}: 2FA timeout — no code received in ${TWOFACTOR_TIMEOUT_MS / 1000}s.`);
        return "";
      };

      // ── Run scraper ─────────────────────────────────────
      await updateTask({ phase: 1, message: "Starting scraper..." });

      const result = await bank.scrape({
        rut: creds.rut,
        password: creds.password,
        chromePath: process.env.CHROME_PATH,
        onTwoFactorCode,
        onProgress: async (step: string) => {
          log(`Task ${taskId}: ${step}`);
          await updateTask({ message: step });
        },
      });

      if (!result.success) {
        await updateTask({
          status: "error",
          error_message: result.error ?? "Unknown scraper error",
        });
        warn(`Task ${taskId}: scraper failed — ${result.error}`);
        return;
      }

      log(
        `Task ${taskId}: scraper returned ${result.movements.length} movement(s).`,
      );

      // ── Upload movements ────────────────────────────────
      await updateTask({
        phase: 4,
        message: "Uploading movements...",
      });

      let inserted = 0;
      for (const m of result.movements) {
        const hash = movementHash(
          userId,
          bankId,
          m.date,
          m.description,
          m.amount,
        );
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

      // ── Mark done ───────────────────────────────────────
      await updateTask({
        status: "done",
        phase: 5,
        message: `Sync complete: ${inserted} movements inserted`,
        movements_inserted: inserted,
      });

      log(
        `Task ${taskId}: done. ${inserted} new movements out of ${result.movements.length} total.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected error";
      warn(`Task ${taskId}: unhandled error — ${message}`);
      await updateTask({
        status: "error",
        error_message: message,
      }).catch(() => {});
    }
  };

  // ── Subscribe to sync_tasks via Realtime ─────────────────
  let channel: RealtimeChannel;

  const subscribe = () => {
    channel = supabase
      .channel("agent-sync-tasks")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "sync_tasks",
          filter: `status=eq.pending`,
        },
        (payload) => {
          const row = payload.new as {
            id: string;
            bank_id: string;
            user_id: string;
            status: string;
          };

          // Only handle banks we have credentials for
          const bankIds = configuredBanks.map((b) => b.id);
          if (!bankIds.includes(row.bank_id)) {
            return;
          }

          handleTask(row.id, row.bank_id, row.user_id).catch((err) => {
            warn(`Task handler crashed: ${(err as Error).message}`);
          });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log("Subscribed to sync_tasks — listening for new tasks.");
        } else if (status === "CHANNEL_ERROR") {
          warn("Realtime channel error. Will retry...");
        } else if (status === "TIMED_OUT") {
          warn("Realtime subscription timed out. Retrying...");
          channel.unsubscribe();
          setTimeout(subscribe, 5000);
        }
      });
  };

  subscribe();

  // ── Graceful shutdown ────────────────────────────────────
  const shutdown = async (signal: string) => {
    log(`Received ${signal}. Shutting down gracefully...`);
    clearInterval(heartbeatTimer);

    // Remove presence
    try {
      await supabase
        .from("agent_presence")
        .delete()
        .eq("agent_id", agentId);
    } catch {
      // best-effort
    }

    // Unsubscribe from realtime
    try {
      if (channel) await channel.unsubscribe();
    } catch {
      // best-effort
    }

    log("Agent stopped.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log("Agent is running. Press Ctrl+C to stop.");
}

// ─── Agent ID (generated once per session) ────────────────────

const agentId = randomUUID();

// ─── CLI entry point ──────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse --token flag
  let token: string | undefined;
  const tokenIdx = args.indexOf("--token");
  if (tokenIdx >= 0 && args[tokenIdx + 1]) {
    token = args[tokenIdx + 1];
  }

  // Parse --url flag
  let webUrl: string | undefined;
  const urlIdx = args.indexOf("--url");
  if (urlIdx >= 0 && args[urlIdx + 1]) {
    webUrl = args[urlIdx + 1];
  }

  // --help
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
open-banking-chile serve — Local sync agent

Usage:
  open-banking-chile serve [--token <token>] [--url <dashboard-url>]

The agent connects to Supabase, announces its presence, and listens for
sync tasks. When a task arrives, it runs the appropriate bank scraper and
uploads movements.

Credentials are fetched automatically from your dashboard account.
No local env vars needed -- just authenticate once with your token.

Options:
  --token <token>  Agent auth token (or paste interactively on first run)
  --url <url>      Dashboard URL (default: ${DEFAULT_WEB_URL})
  --help, -h       Show this help

Environment (fallback, optional):
  SUPABASE_URL       Supabase project URL
  SUPABASE_ANON_KEY  Supabase anonymous key
  <BANK>_RUT         RUT for each bank  (e.g. BICE_RUT=12345678-9)
  <BANK>_PASS        Password for each bank (e.g. BICE_PASS=mypassword)
  CHROME_PATH        Custom Chrome/Chromium path (optional)

Examples:
  # First run — authenticates interactively
  npx open-banking-chile serve

  # Run with explicit token
  npx open-banking-chile serve --token eyJhbG...

  # Run against a custom dashboard URL
  npx open-banking-chile serve --url http://localhost:3434
`);
    process.exit(0);
  }

  await startAgent(token, webUrl);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
