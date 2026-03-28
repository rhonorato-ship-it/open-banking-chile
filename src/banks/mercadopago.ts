import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── MercadoPago API constants ───────────────────────────────────
//
// MercadoPago has a public REST API at api.mercadopago.com.
// Auth: OAuth2 with personal access token from mercadopago.cl/developers.
// The password field accepts the APP_USR-... access token.
//
// IMPORTANT: The MercadoPago API is seller/merchant-oriented.
// It shows payments received, not purchases made as a buyer.
// Buyer-only accounts may return zero movements — this is an API limitation.

const API_BASE = "https://api.mercadopago.com";
const PAYMENTS_LIMIT = 100;
const MAX_PAGES = 20;

// ─── API types ───────────────────────────────────────────────────

interface MpUser {
  id: number;
  site_id: string;
  email: string;
  first_name: string;
  last_name: string;
}

interface MpBalance {
  available_balance: number;
  total_amount: number;
  unavailable_balance: number;
}

interface MpPayment {
  id: number;
  date_created: string;
  date_approved: string | null;
  description: string;
  transaction_amount: number;
  currency_id: string;
  status: string;
  status_detail: string;
  payment_type_id: string;
  operation_type: string;
}

interface MpSearchResponse {
  results: MpPayment[];
  paging: { total: number; limit: number; offset: number };
}

interface MpSessionData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  user_id?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseTokenInput(password: string): MpSessionData {
  // Try JSON first (session blob from previous run)
  if (password.startsWith("{")) {
    try {
      return JSON.parse(password) as MpSessionData;
    } catch { /* not JSON, treat as raw token */ }
  }
  // Raw APP_USR-... token
  return { access_token: password };
}

async function mpGet<T>(token: string, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`MP GET ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function mpPost<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`MP POST ${path} → ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ─── Data fetchers ───────────────────────────────────────────────

async function fetchUserInfo(token: string, debugLog: string[]): Promise<MpUser> {
  debugLog.push("1. Fetching user info...");
  const user = await mpGet<MpUser>(token, "/users/me");
  debugLog.push(`  User: ${user.first_name} ${user.last_name} (${user.email}), site: ${user.site_id}`);
  return user;
}

async function fetchBalance(token: string, userId: number, debugLog: string[]): Promise<number | undefined> {
  debugLog.push("2. Fetching account balance...");
  try {
    const balance = await mpGet<MpBalance>(token, `/users/${userId}/mercadopago_account/balance`);
    debugLog.push(`  Available: $${balance.available_balance.toLocaleString("es-CL")}`);
    return balance.available_balance;
  } catch (err) {
    debugLog.push(`  Balance not available: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function fetchPayments(token: string, userId: number, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("3. Searching payments...");
  const movements: BankMovement[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await mpGet<MpSearchResponse>(token, "/v1/payments/search", {
      "collector.id": String(userId),
      sort: "date_created",
      criteria: "desc",
      limit: String(PAYMENTS_LIMIT),
      offset: String(offset),
    });

    for (const p of res.results) {
      if (p.status !== "approved") continue;
      const dateStr = p.date_approved || p.date_created;
      const date = normalizeDate(dateStr.split("T")[0]);
      const isIncoming = p.operation_type === "regular_payment" || p.operation_type === "money_transfer";
      movements.push({
        date,
        description: p.description || `${p.payment_type_id} #${p.id}`,
        amount: isIncoming ? Math.abs(p.transaction_amount) : -Math.abs(p.transaction_amount),
        balance: 0,
        source: MOVEMENT_SOURCE.account,
      });
    }

    debugLog.push(`  Page ${page + 1}: ${res.results.length} payments (${res.results.filter(p => p.status === "approved").length} approved)`);

    offset += res.paging.limit;
    if (offset >= res.paging.total || res.results.length === 0) break;
  }

  return movements;
}

async function fetchSettlementMovements(token: string, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("4. Generating settlement report...");
  const now = new Date();
  const from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().split("T")[0] + "T00:00:00Z";

  let reportFile: string;
  try {
    const report = await mpPost<{ id: number; file_name: string; status: string }>(token, "/v1/account/settlement_report", {
      begin_date: formatDate(from),
      end_date: formatDate(now),
    });
    reportFile = report.file_name;
    debugLog.push(`  Report generated: ${reportFile}`);
  } catch (err) {
    // Settlement reports may not be available for non-seller accounts
    debugLog.push(`  Settlement report not available: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Download CSV
  try {
    const csvRes = await fetch(`${API_BASE}/v1/account/settlement_report/${reportFile}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!csvRes.ok) {
      debugLog.push(`  Report download failed: ${csvRes.status}`);
      return [];
    }
    const csv = await csvRes.text();
    return parseSettlementCsv(csv, debugLog);
  } catch (err) {
    debugLog.push(`  Report download error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function parseSettlementCsv(csv: string, debugLog: string[]): BankMovement[] {
  const lines = csv.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  // Detect delimiter (MercadoPago uses ; in some locales, , in others)
  const header = lines[0];
  const delim = header.includes(";") ? ";" : ",";
  const cols = header.split(delim).map(c => c.trim().replace(/^"|"$/g, ""));

  const dateIdx = cols.findIndex(c => c === "DATE" || c === "FECHA");
  const descIdx = cols.findIndex(c => c === "DESCRIPTION" || c === "DESCRIPCION");
  const creditIdx = cols.findIndex(c => c === "NET_CREDIT" || c.includes("CREDIT"));
  const debitIdx = cols.findIndex(c => c === "NET_DEBIT" || c.includes("DEBIT"));
  const typeIdx = cols.findIndex(c => c === "RECORD_TYPE" || c === "TIPO_REGISTRO");

  if (dateIdx < 0 || (creditIdx < 0 && debitIdx < 0)) {
    debugLog.push("  CSV columns not recognized");
    return [];
  }

  const movements: BankMovement[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(delim).map(f => f.trim().replace(/^"|"$/g, ""));
    // Skip summary/total/initial rows
    if (typeIdx >= 0) {
      const rt = fields[typeIdx]?.toLowerCase() || "";
      if (rt === "initial" || rt === "total" || rt === "inicial") continue;
    }

    const rawDate = fields[dateIdx] || "";
    const date = normalizeDate(rawDate.split("T")[0]);
    if (!date || date === "Invalid") continue;

    const credit = parseFloat((fields[creditIdx] || "0").replace(/,/g, "")) || 0;
    const debit = parseFloat((fields[debitIdx] || "0").replace(/,/g, "")) || 0;
    const amount = credit - debit;
    if (amount === 0) continue;

    movements.push({
      date,
      description: fields[descIdx] || "Movimiento MercadoPago",
      amount,
      balance: 0,
      source: MOVEMENT_SOURCE.account,
    });
  }

  debugLog.push(`  Parsed ${movements.length} movements from CSV`);
  return movements;
}

// ─── Token refresh ───────────────────────────────────────────────

async function refreshTokenIfNeeded(session: MpSessionData, debugLog: string[]): Promise<MpSessionData> {
  if (!session.refresh_token) return session;

  const clientId = process.env.MERCADOPAGO_CLIENT_ID;
  const clientSecret = process.env.MERCADOPAGO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return session;

  // Only refresh if expires_at is within 7 days
  if (session.expires_at && session.expires_at > Date.now() + 7 * 24 * 60 * 60 * 1000) return session;

  debugLog.push("0. Refreshing access token...");
  try {
    const res = await fetch(`${API_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: session.refresh_token,
      }),
    });
    if (res.ok) {
      const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
      debugLog.push("  Token refreshed successfully");
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        user_id: session.user_id,
      };
    }
    debugLog.push(`  Refresh failed: ${res.status} — using existing token`);
  } catch { /* use existing token */ }
  return session;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeMercadopago(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: _identifier, password, onProgress } = options;
  const bank = "mercadopago";
  const progress = onProgress || (() => {});

  if (!password || (!password.startsWith("APP_USR") && !password.startsWith("{"))) {
    return {
      success: false, bank, movements: [],
      error: "MercadoPago requiere un access token (APP_USR-...) de mercadopago.cl/developers/panel/app. Usa ese token como contraseña.",
      debug: debugLog.join("\n"),
    };
  }

  let session = parseTokenInput(password);
  session = await refreshTokenIfNeeded(session, debugLog);
  const token = session.access_token;

  progress("Conectando con MercadoPago API...");
  let user: MpUser;
  try {
    user = await fetchUserInfo(token, debugLog);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = msg.includes("401") ? " Token inválido o expirado. Genera uno nuevo en mercadopago.cl/developers." : "";
    return { success: false, bank, movements: [], error: `Error de autenticación: ${msg}.${hint}`, debug: debugLog.join("\n") };
  }

  if (user.site_id !== "MLC") {
    debugLog.push(`  Warning: site_id is ${user.site_id}, expected MLC (Chile)`);
  }

  progress("Sesión iniciada correctamente");

  // Fetch data in parallel (balance is independent, payments + settlement can overlap)
  const [balanceResult, paymentsResult, settlementResult] = await Promise.allSettled([
    fetchBalance(token, user.id, debugLog),
    fetchPayments(token, user.id, debugLog),
    fetchSettlementMovements(token, debugLog),
  ]);

  const balance = balanceResult.status === "fulfilled" ? balanceResult.value : undefined;
  const payments = paymentsResult.status === "fulfilled" ? paymentsResult.value : [];
  const settlements = settlementResult.status === "fulfilled" ? settlementResult.value : [];

  if (paymentsResult.status === "rejected") debugLog.push(`  Payments error: ${paymentsResult.reason}`);
  if (settlementResult.status === "rejected") debugLog.push(`  Settlement error: ${settlementResult.reason}`);

  const allMovements = deduplicateMovements([...payments, ...settlements]);
  debugLog.push(`5. Total: ${allMovements.length} unique movements`);

  if (allMovements.length === 0) {
    debugLog.push("  Note: 0 movements may be normal for buyer-only accounts — the MercadoPago API only shows seller/wallet activity.");
  }

  progress(`Listo — ${allMovements.length} movimientos totales`);

  // Persist session for token refresh on next run
  const sessionCookies = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    user_id: user.id,
  });

  return { success: true, bank, movements: allMovements, balance, sessionCookies, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const mercadopago: BankScraper = {
  id: "mercadopago",
  name: "MercadoPago",
  url: "https://www.mercadopago.cl",
  mode: "api",
  scrape: (options) => runApiScraper("mercadopago", options, scrapeMercadopago),
};

export default mercadopago;
