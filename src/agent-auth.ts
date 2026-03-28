import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ─── Config types ─────────────────────────────────────────────

export interface AgentConfig {
  token: string;
  supabaseUrl?: string;
  supabaseKey?: string;
}

// ─── Config path ──────────────────────────────────────────────

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "open-banking-chile",
);
const CONFIG_FILE = path.join(CONFIG_DIR, "agent.json");

// ─── Load / Save ──────────────────────────────────────────────

/**
 * Reads agent config from ~/.config/open-banking-chile/agent.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export function loadConfig(): AgentConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.token) return null;
    return parsed as AgentConfig;
  } catch {
    return null;
  }
}

/**
 * Writes agent config to ~/.config/open-banking-chile/agent.json.
 * Creates the directory if it doesn't exist.
 */
export function saveConfig(config: AgentConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600, // owner read/write only — contains auth token
  });
}

// ─── Supabase client ──────────────────────────────────────────

/**
 * Creates a Supabase client authenticated with the agent's bearer token.
 * The token is sent as a custom Authorization header on every request.
 *
 * URL and anon key are resolved in order:
 *   1. Environment variables (SUPABASE_URL / SUPABASE_ANON_KEY)
 *   2. Values from the saved config file
 *
 * Throws if URL or anon key cannot be resolved.
 */
export function createAgentSupabase(
  token: string,
  opts?: { supabaseUrl?: string; supabaseKey?: string },
): SupabaseClient {
  const url = opts?.supabaseUrl || process.env.SUPABASE_URL;
  const key = opts?.supabaseKey || process.env.SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error(
      "Missing Supabase URL. Set SUPABASE_URL env var or include supabaseUrl in agent config.",
    );
  }
  if (!key) {
    throw new Error(
      "Missing Supabase anon key. Set SUPABASE_ANON_KEY env var or include supabaseKey in agent config.",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}
