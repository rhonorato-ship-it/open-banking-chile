import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements, normalizeInstallments } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Santander constants ────────────────────────────────────────
//
// Auth: Angular SPA with login iframe posting to Santander's identity platform.
// The flow is: GET personas page -> POST login credentials -> 2FA push -> session cookies -> REST APIs.
// Data: REST JSON APIs at banco.santander.cl served by Angular backend.
//
// No browser needed — this scraper uses fetch() exclusively.

const HOME_URL = "https://banco.santander.cl/personas";
const LOGIN_URL = "https://banco.santander.cl/login";
const LOGIN_POST_URL = "https://banco.santander.cl/oip/api/auth/login";
const AUTH_VALIDATE_URL = "https://banco.santander.cl/oip/api/auth/validate";
const AUTH_STATUS_URL = "https://banco.santander.cl/oip/api/auth/status";
const API_BASE = "https://banco.santander.cl/oip/api";
const PORTAL_REFERER = "https://banco.santander.cl/personas";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TWO_FA_TIMEOUT_SEC = parseInt(process.env.SANTANDER_2FA_TIMEOUT_SEC || "120", 10);

// ─── API types ───────────────────────────────────────────────────

interface ApiAccount {
  id: string;
  numero: string;
  tipo: string;
  moneda: string;
  mascara: string;
  descripcion: string;
  saldo?: number;
  saldoDisponible?: number;
  saldoContable?: number;
}

interface ApiMovement {
  fecha: string;
  descripcion: string;
  monto: number;
  saldo: number;
  tipo: string; // "cargo" | "abono"
}

interface ApiMovementsResponse {
  movimientos: ApiMovement[];
  totalRegistros?: number;
  masPaginas?: boolean;
}

interface ApiCreditCard {
  id: string;
  numero: string;
  mascara: string;
  marca: string;
  tipo: string;
  titular: boolean;
}

interface ApiCreditCardBalance {
  cupoTotalNacional: number;
  cupoUtilizadoNacional: number;
  cupoDisponibleNacional: number;
  cupoTotalInternacional: number;
  cupoUtilizadoInternacional: number;
  cupoDisponibleInternacional: number;
}

interface ApiUnbilledMovement {
  fecha: string;
  descripcion: string;
  monto: number;
  cuotas?: string;
}

interface ApiBilledMovement {
  fecha: string;
  descripcion: string;
  monto: number;
  cuotas?: string;
  tipo?: string; // "cargo" | "abono" | "pago"
}

// ─── Cookie jar ──────────────────────────────────────────────────

interface CookieJar {
  cookies: Map<string, string>;
  set(raw: string): void;
  setAll(headers: Headers): void;
  header(): string;
  get(name: string): string | undefined;
}

function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    cookies,
    set(raw: string) {
      const [nameValue] = raw.split(";");
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx > 0) cookies.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
    },
    setAll(headers: Headers) {
      const setCookies = headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) this.set(raw);
    },
    header() {
      return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(name: string) {
      return cookies.get(name);
    },
  };
}

// ─── Login ───────────────────────────────────────────────────────

async function santanderLogin(
  rut: string,
  password: string,
  debugLog: string[],
  onTwoFactorCode?: () => Promise<string>,
  onProgress?: (step: string) => void,
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  const jar = createCookieJar();
  const progress = onProgress || (() => {});
  const cleanRut = rut.replace(/[.\-]/g, "");

  // Step 1: GET home page to collect initial cookies / CSRF tokens
  debugLog.push("1. Fetching Santander home page...");
  const homeRes = await fetch(HOME_URL, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  jar.setAll(homeRes.headers);
  debugLog.push(`  Status: ${homeRes.status}, cookies: ${jar.cookies.size}`);

  // Step 2: GET login page to collect login-specific cookies
  debugLog.push("2. Fetching login page...");
  const loginPageRes = await fetch(LOGIN_URL, {
    headers: { "User-Agent": UA, Accept: "text/html", Cookie: jar.header(), Referer: HOME_URL },
    redirect: "follow",
  });
  jar.setAll(loginPageRes.headers);
  debugLog.push(`  Status: ${loginPageRes.status}, cookies: ${jar.cookies.size}`);

  // Step 3: POST credentials
  debugLog.push("3. Submitting credentials...");
  const loginBody = { rut: cleanRut, password };

  const csrfToken = jar.get("XSRF-TOKEN") || jar.get("csrf-token") || jar.get("_csrf");
  const csrfHeaders: Record<string, string> = {};
  if (csrfToken) {
    csrfHeaders["X-XSRF-TOKEN"] = decodeURIComponent(csrfToken);
  }

  const loginRes = await fetch(LOGIN_POST_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: LOGIN_URL,
      Origin: "https://banco.santander.cl",
      ...csrfHeaders,
    },
    body: JSON.stringify(loginBody),
    redirect: "manual",
  });
  jar.setAll(loginRes.headers);
  debugLog.push(`  Login response: ${loginRes.status}`);

  // Handle redirect-based login (302/303)
  if (loginRes.status >= 300 && loginRes.status < 400) {
    const location = loginRes.headers.get("location") || "";
    debugLog.push(`  Redirect: ${location}`);
    if (location.includes("login") || location.includes("error")) {
      return { success: false, error: "Credenciales incorrectas (RUT o clave invalida)." };
    }
    const redirectRes = await fetch(
      location.startsWith("http") ? location : `https://banco.santander.cl${location}`,
      { headers: { "User-Agent": UA, Cookie: jar.header() }, redirect: "follow" },
    );
    jar.setAll(redirectRes.headers);
  }

  // Handle JSON error responses
  if (loginRes.status === 401 || loginRes.status === 403) {
    return { success: false, error: "Credenciales incorrectas (RUT o clave invalida)." };
  }

  // Try to read JSON response for status/2FA info
  let loginJson: Record<string, unknown> = {};
  try {
    loginJson = await loginRes.json() as Record<string, unknown>;
  } catch { /* not JSON */ }

  if (loginJson.error || loginJson.status === "ERROR" || loginJson.status === "FAILED") {
    const msg = (loginJson.message || loginJson.error || "Error de autenticacion") as string;
    return { success: false, error: msg };
  }

  // Step 4: Handle 2FA push notification
  const needs2FA = loginJson.requires2FA === true
    || loginJson.twoFactorRequired === true
    || loginJson.status === "PENDING_2FA"
    || loginJson.step === "2FA"
    || loginRes.status === 202;

  if (needs2FA) {
    debugLog.push("4. 2FA push notification required — waiting for approval...");
    progress("Esperando aprobacion 2FA en tu celular...");

    const pollInterval = 3000;
    const maxAttempts = Math.ceil((TWO_FA_TIMEOUT_SEC * 1000) / pollInterval);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, pollInterval));

      try {
        const statusRes = await fetch(AUTH_STATUS_URL, {
          headers: {
            "User-Agent": UA,
            Accept: "application/json",
            Cookie: jar.header(),
            ...csrfHeaders,
          },
        });
        jar.setAll(statusRes.headers);

        if (statusRes.ok) {
          const statusJson = await statusRes.json() as Record<string, unknown>;
          debugLog.push(`  2FA poll ${attempt + 1}: ${JSON.stringify(statusJson).slice(0, 100)}`);

          if (statusJson.status === "APPROVED" || statusJson.authenticated === true || statusJson.status === "OK") {
            debugLog.push("  2FA approved!");
            break;
          }
          if (statusJson.status === "REJECTED" || statusJson.status === "TIMEOUT" || statusJson.status === "CANCELLED") {
            return { success: false, error: `2FA ${statusJson.status === "REJECTED" ? "rechazada" : "timeout"}.` };
          }
        }
      } catch {
        debugLog.push(`  2FA poll ${attempt + 1}: network error, retrying...`);
      }

      if (attempt === maxAttempts - 1) {
        return { success: false, error: "Timeout esperando aprobacion de 2FA." };
      }
    }
  } else {
    debugLog.push("4. No 2FA required (or auto-approved).");
  }

  // Step 5: Validate session
  debugLog.push("5. Validating session...");
  try {
    const validateRes = await fetch(AUTH_VALIDATE_URL, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: jar.header(),
        Referer: PORTAL_REFERER,
        ...csrfHeaders,
      },
    });
    jar.setAll(validateRes.headers);
    debugLog.push(`  Validate: ${validateRes.status}`);

    if (!validateRes.ok && validateRes.status !== 404) {
      // 404 means the endpoint doesn't exist, which is fine — session may still be valid
      return { success: false, error: "No se pudo validar la sesion despues del login." };
    }
  } catch {
    debugLog.push("  Validate endpoint not available, continuing...");
  }

  debugLog.push(`  Login OK! Cookies: ${Array.from(jar.cookies.keys()).join(", ")}`);
  return { success: true, jar };
}

// ─── API helpers ─────────────────────────────────────────────────

async function apiGet<T>(jar: CookieJar, path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const csrfToken = jar.get("XSRF-TOKEN");
  const csrfHeaders: Record<string, string> = {};
  if (csrfToken) csrfHeaders["X-XSRF-TOKEN"] = decodeURIComponent(csrfToken);

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: PORTAL_REFERER,
      Origin: "https://banco.santander.cl",
      ...csrfHeaders,
    },
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(jar: CookieJar, path: string, body: unknown = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const csrfToken = jar.get("XSRF-TOKEN");
  const csrfHeaders: Record<string, string> = {};
  if (csrfToken) csrfHeaders["X-XSRF-TOKEN"] = decodeURIComponent(csrfToken);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: PORTAL_REFERER,
      Origin: "https://banco.santander.cl",
      ...csrfHeaders,
    },
    body: JSON.stringify(body),
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API POST ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Data extraction ─────────────────────────────────────────────

function apiMovToMovement(mov: ApiMovement): BankMovement {
  return {
    date: normalizeDate(mov.fecha),
    description: mov.descripcion.trim(),
    amount: mov.tipo === "cargo" ? -Math.abs(mov.monto) : Math.abs(mov.monto),
    balance: mov.saldo,
    source: MOVEMENT_SOURCE.account,
  };
}

function unbilledToMovement(mov: ApiUnbilledMovement): BankMovement {
  return {
    date: normalizeDate(mov.fecha),
    description: mov.descripcion.trim(),
    amount: -Math.abs(mov.monto),
    balance: 0,
    source: MOVEMENT_SOURCE.credit_card_unbilled,
    installments: normalizeInstallments(mov.cuotas),
  };
}

function billedToMovement(mov: ApiBilledMovement, source: MovementSource): BankMovement {
  const isPago = mov.tipo === "pago" || mov.tipo === "abono";
  return {
    date: normalizeDate(mov.fecha),
    description: mov.descripcion.trim(),
    amount: isPago ? Math.abs(mov.monto) : -Math.abs(mov.monto),
    balance: 0,
    source,
    installments: normalizeInstallments(mov.cuotas),
  };
}

// ─── Account movements ──────────────────────────────────────────

async function fetchAccountMovements(
  jar: CookieJar,
  accounts: ApiAccount[],
  debugLog: string[],
): Promise<{ movements: BankMovement[]; balance?: number }> {
  const movements: BankMovement[] = [];
  let balance: number | undefined;

  for (const acct of accounts) {
    debugLog.push(`  Fetching movements for ${acct.descripcion || acct.tipo} ${acct.mascara || acct.numero}`);

    try {
      // Try multiple possible endpoint patterns for account movements
      let movsResponse: ApiMovementsResponse | null = null;

      const endpoints = [
        `cuentas/${acct.id}/movimientos`,
        `cuentas/movimientos`,
        `movimientos/cuenta/${acct.id}`,
        `movimientos/cuenta`,
      ];

      for (const endpoint of endpoints) {
        try {
          movsResponse = endpoint.includes("movimientos/cuenta") && !endpoint.endsWith(acct.id)
            ? await apiPost<ApiMovementsResponse>(jar, endpoint, { cuentaId: acct.id, numero: acct.numero })
            : await apiGet<ApiMovementsResponse>(jar, endpoint);
          if (movsResponse?.movimientos) break;
        } catch { continue; }
      }

      if (movsResponse?.movimientos) {
        for (const mov of movsResponse.movimientos) {
          movements.push(apiMovToMovement(mov));
        }

        // Extract balance from first movement or account data
        if (balance === undefined && acct.moneda === "CLP") {
          if (acct.saldoDisponible !== undefined) {
            balance = acct.saldoDisponible;
          } else if (acct.saldo !== undefined) {
            balance = acct.saldo;
          } else if (movsResponse.movimientos.length > 0) {
            balance = movsResponse.movimientos[0].saldo;
          }
        }

        // Pagination
        let hasMore = movsResponse.masPaginas ?? false;
        let page = 2;
        while (hasMore && page <= 25) {
          try {
            const nextPage = await apiPost<ApiMovementsResponse>(jar, `cuentas/${acct.id}/movimientos`, { pagina: page });
            if (!nextPage.movimientos?.length) break;
            for (const mov of nextPage.movimientos) movements.push(apiMovToMovement(mov));
            hasMore = nextPage.masPaginas ?? false;
            page++;
          } catch { break; }
        }
      }

      debugLog.push(`    -> ${movsResponse?.movimientos?.length ?? 0} movement(s)`);
    } catch (err) {
      debugLog.push(`    -> Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { movements, balance };
}

// ─── Credit card data ────────────────────────────────────────────

async function fetchCreditCardData(
  jar: CookieJar,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  // Fetch credit card list
  let cards: ApiCreditCard[] = [];
  try {
    cards = await apiGet<ApiCreditCard[]>(jar, "tarjetas/credito");
  } catch {
    try {
      cards = await apiGet<ApiCreditCard[]>(jar, "tarjetas");
    } catch {
      return { movements, creditCards };
    }
  }

  if (!cards || cards.length === 0) return { movements, creditCards };
  debugLog.push(`  Found ${cards.length} credit card(s)`);

  for (const card of cards) {
    const cardLabel = `${card.marca} ${card.tipo} ${card.mascara || `****${card.numero.slice(-4)}`}`.trim();

    // Fetch balance info
    const [balanceResult, unbilledResult] = await Promise.allSettled([
      apiGet<ApiCreditCardBalance>(jar, `tarjetas/${card.id}/saldo`),
      apiGet<{ movimientos: ApiUnbilledMovement[] }>(jar, `tarjetas/${card.id}/movimientos/no-facturados`),
    ]);

    // Build credit card balance entry
    if (balanceResult.status === "fulfilled") {
      const s = balanceResult.value;
      creditCards.push({
        label: cardLabel,
        national: { used: s.cupoUtilizadoNacional, available: s.cupoDisponibleNacional, total: s.cupoTotalNacional },
        international: { used: s.cupoUtilizadoInternacional, available: s.cupoDisponibleInternacional, total: s.cupoTotalInternacional, currency: "USD" },
      });
    } else {
      creditCards.push({ label: cardLabel });
    }

    // Unbilled movements ("movimientos por facturar")
    if (unbilledResult.status === "fulfilled" && unbilledResult.value.movimientos) {
      for (const mov of unbilledResult.value.movimientos) {
        movements.push(unbilledToMovement(mov));
      }
      debugLog.push(`    Unbilled: ${unbilledResult.value.movimientos.length} movement(s)`);
    }

    // Billed movements ("movimientos facturados")
    try {
      const billedRes = await apiGet<{ movimientos: ApiBilledMovement[] }>(jar, `tarjetas/${card.id}/movimientos/facturados`);
      if (billedRes.movimientos) {
        for (const mov of billedRes.movimientos) {
          movements.push(billedToMovement(mov, MOVEMENT_SOURCE.credit_card_billed));
        }
        debugLog.push(`    Billed: ${billedRes.movimientos.length} movement(s)`);
      }
    } catch {
      debugLog.push(`    Billed: could not fetch`);
    }
  }

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeSantander(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress, onTwoFactorCode } = options;
  const bank = "santander";
  const progress = onProgress || (() => {});

  // Login
  progress("Conectando con Santander API...");
  const loginResult = await santanderLogin(rut, password, debugLog, onTwoFactorCode, onProgress);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar } = loginResult;
  progress("Sesion iniciada correctamente");

  // Fetch account list
  debugLog.push("6. Fetching accounts...");
  progress("Obteniendo cuentas...");
  let accounts: ApiAccount[] = [];
  try {
    // Try multiple possible endpoints for account listing
    try {
      accounts = await apiGet<ApiAccount[]>(jar, "cuentas");
    } catch {
      try {
        const productsRes = await apiGet<{ cuentas: ApiAccount[] }>(jar, "productos");
        accounts = productsRes.cuentas || [];
      } catch {
        const dashRes = await apiGet<{ cuentas: ApiAccount[] }>(jar, "dashboard/resumen");
        accounts = dashRes.cuentas || [];
      }
    }
    debugLog.push(`  Found ${accounts.length} account(s)`);
  } catch (err) {
    debugLog.push(`  Could not fetch accounts: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Extract balance from account data if available
  let balance: number | undefined;
  const clpAccount = accounts.find(a => a.moneda === "CLP" || !a.moneda);
  if (clpAccount) {
    balance = clpAccount.saldoDisponible ?? clpAccount.saldo;
    if (balance !== undefined) debugLog.push(`  Balance CLP: $${balance}`);
  }

  // Account movements
  debugLog.push("7. Fetching account movements...");
  progress("Extrayendo movimientos de cuenta...");
  const acctResult = await fetchAccountMovements(jar, accounts, debugLog);
  if (balance === undefined && acctResult.balance !== undefined) balance = acctResult.balance;
  debugLog.push(`  Account movements: ${acctResult.movements.length}`);

  // Credit card data
  debugLog.push("8. Fetching credit card data...");
  progress("Extrayendo datos de tarjeta de credito...");
  const tcResult = await fetchCreditCardData(jar, debugLog);
  debugLog.push(`  TC movements: ${tcResult.movements.length}`);

  // Deduplicate and return
  const deduplicated = deduplicateMovements([...acctResult.movements, ...tcResult.movements]);
  debugLog.push(`9. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance,
    creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const santander: BankScraper = {
  id: "santander",
  name: "Banco Santander",
  url: "https://banco.santander.cl/personas",
  mode: "api",
  scrape: (options) => runApiScraper("santander", options, scrapeSantander),
};

export default santander;
