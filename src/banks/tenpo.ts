import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Tenpo API constants ────────────────────────────────────────
//
// Tenpo is a mobile-only Chilean fintech (package: com.krealo.tenpo).
// No APK decompilation has been done yet — this is a skeleton scraper
// that probes common API patterns for a Kotlin-backend neobank.
//
// Known facts:
//   - Mobile-only, no web portal
//   - Package name suggests Krealo (Kotlin backend, likely Spring Boot)
//   - Probable base URLs: api.tenpo.cl, services.tenpo.cl
//
// This scraper tries multiple base URLs and auth patterns.
// If none work, it returns a helpful error explaining what was tried
// and suggesting APK decompilation as the next step.

const CANDIDATE_BASES = [
  "https://api.prod.tenpo.cl",
  "https://api.prod.tenpo.cl/v1",
  "https://api.prod.tenpo.cl/api",
  "https://api.prod.tenpo.cl/api/v1",
  "https://prod-b.tenpo.cl",
  "https://prod-b.tenpo.cl/api",
  "https://prod-c.tenpo.cl",
  "https://prod-c.tenpo.cl/api",
];

const UA = "Tenpo/Android (open-banking-chile)";

// ─── API types ──────────────────────────────────────────────────

interface TenpoAuthResponse {
  token?: string;
  accessToken?: string;
  access_token?: string;
  idToken?: string;
  id_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  user?: Record<string, unknown>;
  error?: string;
  message?: string;
}

interface TenpoMovement {
  id?: string;
  date?: string;
  createdAt?: string;
  created_at?: string;
  description?: string;
  commerce?: string;
  merchant?: string;
  amount?: number;
  balance?: number;
  type?: string;
  category?: string;
  status?: string;
}

interface TenpoMovementsResponse {
  movements?: TenpoMovement[];
  data?: TenpoMovement[];
  items?: TenpoMovement[];
  content?: TenpoMovement[];
  transactions?: TenpoMovement[];
  results?: TenpoMovement[];
}

interface TenpoBalanceResponse {
  balance?: number;
  availableBalance?: number;
  available_balance?: number;
  amount?: number;
  data?: {
    balance?: number;
    availableBalance?: number;
  };
}

// ─── Auth probing ───────────────────────────────────────────────

/** Common auth endpoint paths to try for a neobank API. */
const AUTH_PATHS = [
  "/auth/login",
  "/login",
  "/auth/sign-in",
  "/auth/token",
  "/oauth/token",
  "/v1/auth/login",
  "/api/auth/login",
  "/users/login",
  "/sessions",
];

/** Common auth payload shapes to try. */
function authPayloads(identifier: string, password: string): Array<Record<string, unknown>> {
  return [
    { email: identifier, password },
    { phone: identifier, password },
    { phone: identifier, pin: password },
    { username: identifier, password },
    { rut: identifier, password },
    { identifier, password },
    { grant_type: "password", username: identifier, password },
  ];
}

/**
 * Attempt to authenticate with Tenpo by probing multiple base URLs
 * and auth endpoint patterns. Returns a token if any combination works.
 */
async function tenpoAuth(
  identifier: string,
  password: string,
  debugLog: string[],
): Promise<{ success: true; token: string; baseUrl: string } | { success: false; error: string }> {
  debugLog.push("1. Probing Tenpo API endpoints...");

  const tried: string[] = [];

  for (const base of CANDIDATE_BASES) {
    for (const path of AUTH_PATHS) {
      const url = `${base}${path}`;

      // Try the first (most likely) payload shape per endpoint
      // to avoid excessive requests
      const payloads = authPayloads(identifier, password);
      const payload = payloads[0]; // email + password is most common

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": UA,
          },
          body: JSON.stringify(payload),
        });

        tried.push(`${url} -> HTTP ${res.status}`);
        debugLog.push(`  ${url}: HTTP ${res.status}`);

        if (res.ok) {
          const body = await res.json() as TenpoAuthResponse;
          const token =
            body.token ||
            body.accessToken ||
            body.access_token ||
            body.idToken ||
            body.id_token ||
            "";

          if (token) {
            debugLog.push(`  Auth OK via ${url}`);
            return { success: true, token: String(token), baseUrl: base };
          }

          debugLog.push(`  Response OK but no token found. Keys: ${Object.keys(body).join(", ")}`);

          // If we got a 200 without a token, try other payload shapes
          for (let i = 1; i < payloads.length; i++) {
            try {
              const retryRes = await fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Accept": "application/json",
                  "User-Agent": UA,
                },
                body: JSON.stringify(payloads[i]),
              });

              if (retryRes.ok) {
                const retryBody = await retryRes.json() as TenpoAuthResponse;
                const retryToken =
                  retryBody.token ||
                  retryBody.accessToken ||
                  retryBody.access_token ||
                  retryBody.idToken ||
                  retryBody.id_token ||
                  "";

                if (retryToken) {
                  debugLog.push(`  Auth OK via ${url} (payload variant ${i})`);
                  return { success: true, token: String(retryToken), baseUrl: base };
                }
              }
            } catch {
              // Ignore retry errors
            }
          }
        } else if (res.status === 401 || res.status === 403) {
          // Auth endpoint exists but credentials are wrong
          const body = await res.text().catch(() => "");
          debugLog.push(`  Auth endpoint found but rejected: ${body.slice(0, 200)}`);

          // This is actually useful — we found a valid endpoint
          // Try remaining payload shapes
          for (let i = 1; i < payloads.length; i++) {
            try {
              const retryRes = await fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Accept": "application/json",
                  "User-Agent": UA,
                },
                body: JSON.stringify(payloads[i]),
              });

              if (retryRes.ok) {
                const retryBody = await retryRes.json() as TenpoAuthResponse;
                const retryToken =
                  retryBody.token ||
                  retryBody.accessToken ||
                  retryBody.access_token ||
                  "";

                if (retryToken) {
                  debugLog.push(`  Auth OK via ${url} (payload variant ${i})`);
                  return { success: true, token: String(retryToken), baseUrl: base };
                }
              }
            } catch {
              // Ignore retry errors
            }
          }
        }
        // 404, 500, etc. — try next endpoint
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // DNS/connection failures are expected for wrong base URLs
        if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED")) {
          tried.push(`${url} -> unreachable`);
          debugLog.push(`  ${url}: unreachable (${msg.split(":")[0]})`);
          // Skip remaining paths for this base URL
          break;
        }
        tried.push(`${url} -> error: ${msg.slice(0, 50)}`);
        debugLog.push(`  ${url}: error (${msg.slice(0, 100)})`);
      }
    }
  }

  return {
    success: false,
    error:
      "No se pudo autenticar con Tenpo. " +
      "Tenpo es una app movil sin portal web conocido. " +
      "Este scraper es un esqueleto que prueba patrones comunes de API, " +
      "pero los endpoints reales aun no han sido descubiertos. " +
      `Se probaron ${tried.length} combinaciones de URL sin exito. ` +
      "Siguiente paso: decompilar el APK (com.krealo.tenpo) para descubrir " +
      "los endpoints y el flujo de autenticacion reales.",
  };
}

/**
 * Fetch balance from Tenpo API once authenticated.
 */
async function fetchBalance(
  token: string,
  baseUrl: string,
  debugLog: string[],
): Promise<number | undefined> {
  debugLog.push("2. Fetching balance...");

  const balancePaths = [
    "/accounts/balance",
    "/balance",
    "/wallet/balance",
    "/prepaid/balance",
    "/v1/balance",
    "/users/me/balance",
  ];

  for (const path of balancePaths) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          "User-Agent": UA,
        },
      });

      if (res.ok) {
        const body = await res.json() as TenpoBalanceResponse;
        const bal =
          body.balance ??
          body.availableBalance ??
          body.available_balance ??
          body.amount ??
          body.data?.balance ??
          body.data?.availableBalance;

        if (bal !== undefined && bal !== null) {
          debugLog.push(`  Balance: $${Math.round(bal).toLocaleString("es-CL")} (via ${path})`);
          return Math.round(bal);
        }
      }
    } catch {
      // Try next path
    }
  }

  debugLog.push("  Balance not found at any known endpoint");
  return undefined;
}

/**
 * Fetch movements from Tenpo API once authenticated.
 */
async function fetchMovements(
  token: string,
  baseUrl: string,
  debugLog: string[],
): Promise<BankMovement[]> {
  debugLog.push("3. Fetching movements...");
  const movements: BankMovement[] = [];

  const movementPaths = [
    "/movements",
    "/transactions",
    "/movements/history",
    "/v1/movements",
    "/activity",
    "/users/me/movements",
    "/prepaid/movements",
  ];

  for (const path of movementPaths) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          "User-Agent": UA,
        },
      });

      if (!res.ok) continue;

      const body = await res.json() as TenpoMovementsResponse;
      const items =
        body.movements ||
        body.data ||
        body.items ||
        body.content ||
        body.transactions ||
        body.results ||
        [];

      if (items.length === 0) continue;

      debugLog.push(`  Found ${items.length} movements at ${path}`);

      for (const item of items) {
        const rawDate = item.date || item.createdAt || item.created_at || "";
        if (!rawDate) continue;

        // Normalize date: try ISO format first, then dd-mm-yyyy
        let date = "";
        const isoMatch = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) {
          date = normalizeDate(`${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`);
        } else {
          date = normalizeDate(rawDate);
        }
        if (!date || !/\d{2}-\d{2}-\d{4}/.test(date)) continue;

        const description = item.description || item.commerce || item.merchant || "Movimiento Tenpo";
        const rawAmount = Number(item.amount || 0);
        if (rawAmount === 0) continue;

        const type = (item.type || "").toUpperCase();
        let amount = Math.abs(Math.round(rawAmount));
        if (type === "DEBIT" || type === "CARGO" || type === "PURCHASE" || type === "WITHDRAWAL" || rawAmount < 0) {
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

      // If we found movements at this path, no need to try others
      if (movements.length > 0) break;
    } catch {
      // Try next path
    }
  }

  return movements;
}

// ─── Main scrape function ───────────────────────────────────────

async function scrapeTenpo(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: identifier, password, onProgress } = options;
  const bank = "tenpo";
  const progress = onProgress || (() => {});

  progress("Conectando con Tenpo API...");

  // ── Step 1: Authenticate ──
  const authResult = await tenpoAuth(identifier, password, debugLog);
  if (!authResult.success) {
    return {
      success: false,
      bank,
      movements: [],
      error: authResult.error,
      debug: debugLog.join("\n"),
    };
  }

  const { token, baseUrl } = authResult;
  progress("Sesion iniciada correctamente");
  debugLog.push(`  Using base URL: ${baseUrl}`);

  // ── Step 2: Fetch balance ──
  progress("Obteniendo saldo...");
  const balance = await fetchBalance(token, baseUrl, debugLog);

  // ── Step 3: Fetch movements ──
  progress("Obteniendo movimientos...");
  const rawMovements = await fetchMovements(token, baseUrl, debugLog);
  const movements = deduplicateMovements(rawMovements);

  debugLog.push(`4. Total: ${movements.length} unique movement(s)`);
  progress(`Listo - ${movements.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements,
    balance,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ─────────────────────────────────────────────────────

const tenpo: BankScraper = {
  id: "tenpo",
  name: "Tenpo",
  url: "https://tenpo.cl",
  mode: "api",
  scrape: (options) => runApiScraper("tenpo", options, scrapeTenpo),
};

export default tenpo;
