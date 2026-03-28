import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── MACH API constants ─────────────────────────────────────────
//
// MACH (by BCI) is a mobile-only fintech. No web portal exists.
// API discovered via APK decompilation of cl.bci.sismo.mach.
//
// Auth: device-bound with AES-GCM encrypted PIN. The full flow
// requires device registration, so this scraper is best-effort:
// it attempts auth via known endpoints and returns a helpful error
// if device binding prevents authentication from a server context.
//
// Base URL: https://api.soymach.com/mobile/
// Auth headers: Content-Type, Accept-Version, mach-header-id, Authorization

const API_BASE = "https://api.soymach.com/mobile";
const ACCEPT_VERSION = "0.31.0";

const UA = "MACH/Android (open-banking-chile)";

// ─── API types ──────────────────────────────────────────────────

interface MachBalance {
  balance?: number;
  availableBalance?: number;
  currency?: string;
}

interface MachAccountInfo {
  accountNumber?: string;
  accountType?: string;
  name?: string;
  rut?: string;
}

interface MachMovement {
  id?: string;
  date?: string;
  createdAt?: string;
  description?: string;
  commerce?: string;
  amount?: number;
  balance?: number;
  type?: string; // "DEBIT" | "CREDIT" | etc.
  category?: string;
}

interface MachMovementsResponse {
  movements?: MachMovement[];
  data?: MachMovement[];
  items?: MachMovement[];
  content?: MachMovement[];
}

interface MachCreditLineBalance {
  usedAmount?: number;
  availableAmount?: number;
  totalAmount?: number;
  currency?: string;
}

interface MachCreditLineMovement {
  id?: string;
  date?: string;
  description?: string;
  commerce?: string;
  amount?: number;
  installments?: string;
  type?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

function machHeaders(token: string, deviceId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Accept-Version": ACCEPT_VERSION,
    "mach-header-id": deviceId,
    "Authorization": `Bearer ${token}`,
    "User-Agent": UA,
  };
}

/**
 * Generate a deterministic device ID from the phone number.
 * MACH uses a UUID-like device ID bound during registration.
 * This is a placeholder — real device IDs come from the app.
 */
function generateDeviceId(phone: string): string {
  // Simple hash-like derivation (not cryptographic, just for consistency)
  const clean = phone.replace(/\D/g, "");
  const pad = clean.padEnd(32, "0").slice(0, 32);
  return `${pad.slice(0, 8)}-${pad.slice(8, 12)}-${pad.slice(12, 16)}-${pad.slice(16, 20)}-${pad.slice(20, 32)}`;
}

/**
 * Attempt to authenticate with MACH.
 *
 * MACH uses device-bound auth where the PIN is encrypted via AES-GCM
 * before sending. Without a registered device, this will likely fail.
 * The scraper attempts the known endpoints and returns a clear error
 * explaining the limitation if auth fails.
 */
async function machAuth(
  phone: string,
  pin: string,
  debugLog: string[],
): Promise<{ success: true; token: string; deviceId: string } | { success: false; error: string }> {
  debugLog.push("1. Attempting MACH authentication...");

  const deviceId = generateDeviceId(phone);
  debugLog.push(`  Device ID (derived): ${deviceId.slice(0, 8)}...`);

  // Attempt 1: Try PIN authentication endpoint
  // The real app encrypts the PIN with AES-GCM. We try sending it
  // as-is first (some API versions may accept plaintext in debug mode)
  // and then as a structured encrypted payload.
  try {
    debugLog.push("  Trying PIN auth endpoint...");
    const pinRes = await fetch(`${API_BASE}/credentials/security-pin/authentication/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Version": ACCEPT_VERSION,
        "mach-header-id": deviceId,
        "User-Agent": UA,
      },
      body: JSON.stringify({
        pin,
        phone,
        deviceId,
      }),
    });

    debugLog.push(`  PIN auth response: HTTP ${pinRes.status}`);

    if (pinRes.ok) {
      const body = await pinRes.json() as Record<string, unknown>;
      const token = String(body.token || body.accessToken || body.access_token || "");
      if (token) {
        debugLog.push("  Auth OK via PIN endpoint");
        return { success: true, token, deviceId };
      }
      debugLog.push(`  PIN auth returned OK but no token. Keys: ${Object.keys(body).join(", ")}`);
    } else if (pinRes.status === 401 || pinRes.status === 403) {
      const body = await pinRes.text().catch(() => "");
      debugLog.push(`  PIN auth rejected: ${body.slice(0, 200)}`);
    } else {
      const body = await pinRes.text().catch(() => "");
      debugLog.push(`  PIN auth error: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    debugLog.push(`  PIN auth request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Attempt 2: Try token acknowledge endpoint (refresh flow)
  try {
    debugLog.push("  Trying token acknowledge endpoint...");
    const ackRes = await fetch(`${API_BASE}/auth/token/acknowledge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Version": ACCEPT_VERSION,
        "mach-header-id": deviceId,
        "User-Agent": UA,
      },
      body: JSON.stringify({
        phone,
        deviceId,
      }),
    });

    debugLog.push(`  Token acknowledge response: HTTP ${ackRes.status}`);

    if (ackRes.ok) {
      const body = await ackRes.json() as Record<string, unknown>;
      const token = String(body.token || body.accessToken || body.access_token || "");
      if (token) {
        debugLog.push("  Auth OK via token acknowledge");
        return { success: true, token, deviceId };
      }
    }
  } catch (e) {
    debugLog.push(`  Token acknowledge failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    success: false,
    error:
      "No se pudo autenticar con MACH. " +
      "La API de MACH requiere un dispositivo registrado con la app (device-bound auth). " +
      "El PIN se encripta con AES-GCM antes de enviarse, lo que no es replicable sin la clave del dispositivo. " +
      "Para usar este scraper, necesitas proporcionar un token Bearer valido obtenido desde la app.",
  };
}

/**
 * Fetch account balance from MACH API.
 */
async function fetchBalance(
  token: string,
  deviceId: string,
  debugLog: string[],
): Promise<number | undefined> {
  debugLog.push("2. Fetching account balance...");
  try {
    const res = await fetch(`${API_BASE}/accounts/balance`, {
      headers: machHeaders(token, deviceId),
    });

    if (!res.ok) {
      debugLog.push(`  Balance request failed: HTTP ${res.status}`);
      return undefined;
    }

    const body = await res.json() as MachBalance;
    const balance = body.availableBalance ?? body.balance;
    if (balance !== undefined && balance !== null) {
      debugLog.push(`  Balance: $${Math.round(balance).toLocaleString("es-CL")}`);
      return Math.round(balance);
    }
    debugLog.push(`  Balance response had no amount. Keys: ${Object.keys(body).join(", ")}`);
  } catch (e) {
    debugLog.push(`  Balance fetch error: ${e instanceof Error ? e.message : String(e)}`);
  }
  return undefined;
}

/**
 * Fetch account movements from MACH API.
 */
async function fetchMovements(
  token: string,
  deviceId: string,
  debugLog: string[],
): Promise<BankMovement[]> {
  debugLog.push("3. Fetching account movements...");
  const movements: BankMovement[] = [];

  try {
    const res = await fetch(`${API_BASE}/movements/history/v2`, {
      headers: machHeaders(token, deviceId),
    });

    if (!res.ok) {
      debugLog.push(`  Movements request failed: HTTP ${res.status}`);
      return movements;
    }

    const body = await res.json() as MachMovementsResponse;
    const items = body.movements || body.data || body.items || body.content || [];
    debugLog.push(`  Raw movements: ${items.length}`);

    for (const item of items) {
      const rawDate = item.date || item.createdAt || "";
      const date = rawDate ? normalizeDate(rawDate.split("T")[0]?.split("-").reverse().join("-") || rawDate) : "";
      if (!date || !/\d{2}-\d{2}-\d{4}/.test(date)) continue;

      const description = item.description || item.commerce || "Movimiento MACH";
      const rawAmount = Number(item.amount || 0);
      if (rawAmount === 0) continue;

      // Determine sign: DEBIT = negative, CREDIT = positive
      const type = (item.type || "").toUpperCase();
      let amount = Math.abs(Math.round(rawAmount));
      if (type === "DEBIT" || type === "CARGO" || type === "PURCHASE" || rawAmount < 0) {
        amount = -amount;
      }

      movements.push({
        date,
        description: description.slice(0, 200),
        amount,
        balance: Math.round(Number(item.balance || 0)),
        source: MOVEMENT_SOURCE.account,
      });
    }
  } catch (e) {
    debugLog.push(`  Movements fetch error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return movements;
}

/**
 * Fetch credit line (MACH credit card) movements.
 */
async function fetchCreditLineMovements(
  token: string,
  deviceId: string,
  debugLog: string[],
): Promise<BankMovement[]> {
  debugLog.push("4. Fetching credit line movements...");
  const movements: BankMovement[] = [];

  // Fetch authorized (unbilled) movements
  try {
    const res = await fetch(`${API_BASE}/credit-lines/movements/authorized`, {
      headers: machHeaders(token, deviceId),
    });

    if (res.ok) {
      const body = await res.json() as MachMovementsResponse;
      const items = body.movements || body.data || body.items || body.content || [];
      debugLog.push(`  Credit line authorized movements: ${items.length}`);

      for (const item of items as MachCreditLineMovement[]) {
        const rawDate = item.date || "";
        const date = rawDate ? normalizeDate(rawDate.split("T")[0]?.split("-").reverse().join("-") || rawDate) : "";
        if (!date || !/\d{2}-\d{2}-\d{4}/.test(date)) continue;

        const description = item.description || item.commerce || "TC MACH";
        const rawAmount = Number(item.amount || 0);
        if (rawAmount === 0) continue;

        movements.push({
          date,
          description: description.slice(0, 200),
          amount: -Math.abs(Math.round(rawAmount)), // CC movements are charges
          balance: 0,
          source: MOVEMENT_SOURCE.credit_card_unbilled,
          installments: item.installments,
        });
      }
    } else {
      debugLog.push(`  Credit line authorized: HTTP ${res.status}`);
    }
  } catch (e) {
    debugLog.push(`  Credit line authorized error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Fetch statement (billed) movements
  try {
    const res = await fetch(`${API_BASE}/credit-lines/movements/statement`, {
      headers: machHeaders(token, deviceId),
    });

    if (res.ok) {
      const body = await res.json() as MachMovementsResponse;
      const items = body.movements || body.data || body.items || body.content || [];
      debugLog.push(`  Credit line statement movements: ${items.length}`);

      for (const item of items as MachCreditLineMovement[]) {
        const rawDate = item.date || "";
        const date = rawDate ? normalizeDate(rawDate.split("T")[0]?.split("-").reverse().join("-") || rawDate) : "";
        if (!date || !/\d{2}-\d{2}-\d{4}/.test(date)) continue;

        const description = item.description || item.commerce || "TC MACH";
        const rawAmount = Number(item.amount || 0);
        if (rawAmount === 0) continue;

        movements.push({
          date,
          description: description.slice(0, 200),
          amount: -Math.abs(Math.round(rawAmount)),
          balance: 0,
          source: MOVEMENT_SOURCE.credit_card_billed,
          installments: item.installments,
        });
      }
    } else {
      debugLog.push(`  Credit line statement: HTTP ${res.status}`);
    }
  } catch (e) {
    debugLog.push(`  Credit line statement error: ${e instanceof Error ? e.message : String(e)}`);
  }

  return movements;
}

// ─── Main scrape function ───────────────────────────────────────

async function scrapeMach(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: phone, password: pin, onProgress } = options;
  const bank = "mach";
  const progress = onProgress || (() => {});

  progress("Conectando con MACH API...");

  // ── Step 1: Authenticate ──
  const authResult = await machAuth(phone, pin, debugLog);
  if (!authResult.success) {
    return {
      success: false,
      bank,
      movements: [],
      error: authResult.error,
      debug: debugLog.join("\n"),
    };
  }

  const { token, deviceId } = authResult;
  progress("Sesion iniciada correctamente");

  // ── Step 2: Fetch balance ──
  progress("Obteniendo saldo...");
  const balance = await fetchBalance(token, deviceId, debugLog);

  // ── Step 3: Fetch account movements ──
  progress("Obteniendo movimientos...");
  const accountMovements = await fetchMovements(token, deviceId, debugLog);

  // ── Step 4: Fetch credit line movements ──
  const creditMovements = await fetchCreditLineMovements(token, deviceId, debugLog);

  // ── Step 5: Combine and deduplicate ──
  const allMovements = deduplicateMovements([...accountMovements, ...creditMovements]);

  debugLog.push(`5. Total: ${allMovements.length} unique movement(s)`);
  progress(`Listo - ${allMovements.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements: allMovements,
    balance,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ─────────────────────────────────────────────────────

const mach: BankScraper = {
  id: "mach",
  name: "MACH",
  url: "https://somosmach.com",
  mode: "api",
  scrape: (options) => runApiScraper("mach", options, scrapeMach),
};

export default mach;
