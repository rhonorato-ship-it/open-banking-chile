import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Fintual API constants ───────────────────────────────────
//
// Fintual exposes a public REST API (https://fintual.cl/api-docs).
// Auth: POST /api/access_tokens with { user: { email, password } }
// Goals: GET /api/goals with X-User-Email + X-User-Token headers
//
// No browser needed — this scraper uses fetch() exclusively.

const API_BASE = "https://fintual.cl/api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── API types ───────────────────────────────────────────────

interface FintualGoal {
  id: string;
  type: string;
  attributes: {
    name: string;
    /** Net Asset Value — current portfolio value in CLP */
    nav: number;
  };
}

interface FintualTokenResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      token: string;
      email: string;
    };
  };
}

interface FintualGoalsResponse {
  data: FintualGoal[];
}

// ─── Helpers ─────────────────────────────────────────────────

async function fintualAuth(
  email: string,
  password: string,
  debugLog: string[],
): Promise<{ token: string; email: string } | { error: string }> {
  debugLog.push("1. Authenticating via Fintual API...");

  const res = await fetch(`${API_BASE}/access_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ user: { email, password } }),
  });

  if (res.status === 401) {
    return { error: "Credenciales incorrectas (email o contraseña inválida)." };
  }
  if (res.status === 422) {
    return { error: "Faltan credenciales (email y contraseña son requeridos)." };
  }
  if (!res.ok) {
    return { error: `Error de autenticación (HTTP ${res.status}).` };
  }

  const body = (await res.json()) as FintualTokenResponse;
  const token = body.data.attributes.token;
  const authedEmail = body.data.attributes.email;
  debugLog.push(`  Auth OK — token received for ${authedEmail}`);
  return { token, email: authedEmail };
}

async function fetchGoals(
  email: string,
  token: string,
  debugLog: string[],
): Promise<FintualGoal[]> {
  debugLog.push("2. Fetching goals...");

  const res = await fetch(`${API_BASE}/goals`, {
    headers: {
      "X-User-Email": email,
      "X-User-Token": token,
      "User-Agent": UA,
    },
  });

  if (!res.ok) {
    throw new Error(`Error al obtener objetivos (HTTP ${res.status}).`);
  }

  const body = (await res.json()) as FintualGoalsResponse;
  debugLog.push(`  Found ${body.data.length} goal(s)`);
  return body.data;
}

// ─── Main scrape function ────────────────────────────────────

async function scrapeFintual(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: email, password, onProgress } = options;
  const bank = "fintual";
  const progress = onProgress || (() => {});

  progress("Conectando con Fintual API...");
  const authResult = await fintualAuth(email, password, debugLog);
  if ("error" in authResult) {
    return { success: false, bank, movements: [], error: authResult.error, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  const goals = await fetchGoals(authResult.email, authResult.token, debugLog);

  progress("Procesando datos...");
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, "0");
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const yyyy = today.getFullYear();
  const dateStr = `${dd}-${mm}-${yyyy}`;

  // Each goal is a portfolio balance snapshot — one entry per goal per day.
  // Use Math.round because NAV fluctuates intraday but CLP has no decimals.
  // Description includes goal ID so the dedup hash is stable across syncs.
  const movements: BankMovement[] = goals.map((goal) => {
    const nav = Math.round(goal.attributes.nav);
    return {
      date: dateStr,
      description: `${goal.attributes.name} (objetivo #${goal.id})`,
      amount: nav,
      balance: nav,
      source: MOVEMENT_SOURCE.account,
    };
  });

  const totalBalance = goals.reduce((sum, g) => sum + g.attributes.nav, 0);

  debugLog.push(`  Total: ${movements.length} goal(s), balance: $${totalBalance.toLocaleString("es-CL")}`);
  progress(`Listo — ${movements.length} objetivo(s), saldo total: $${totalBalance.toLocaleString("es-CL")}`);

  return {
    success: true,
    bank,
    movements,
    balance: totalBalance,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────

const fintual: BankScraper = {
  id: "fintual",
  name: "Fintual",
  url: "https://fintual.cl",
  mode: "api",
  scrape: (options) => runApiScraper("fintual", options, scrapeFintual),
};

export default fintual;
