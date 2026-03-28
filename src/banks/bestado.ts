import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── BancoEstado constants ──────────────────────────────────────
//
// Auth: Angular SPA login at bancoestado.cl, backed by an API POST
// Data: REST API behind Akamai WAF (TLS fingerprinting)
// Risk: Highest probability of Akamai blocking Node.js fetch()
//
// If Akamai blocks the initial GET, we return an informative error
// directing the user to use browser mode with --profile.

const LOGIN_PAGE = "https://www.bancoestado.cl/content/bancoestado-public/cl/es/home/home.html";
const LOGIN_POST_CANDIDATES = [
  "https://www.bancoestado.cl/api/auth/login",
  "https://www.bancoestado.cl/api/login",
  "https://login.bancoestado.cl/api/auth/login",
  "https://login.bancoestado.cl/api/login",
  "https://www.bancoestado.cl/content/bancoestado-public/cl/es/home/home.html/j_security_check",
];
const API_BASE_CANDIDATES = [
  "https://www.bancoestado.cl/api",
  "https://api.bancoestado.cl",
  "https://www.bancoestado.cl/content/bancoestado-public/api",
];
const BALANCE_PATHS = [
  "cuentas/saldos",
  "productos/cuentas/saldos",
  "cuentarut/saldo",
  "cuentas/cuentarut/saldo",
];
const MOVEMENTS_PATHS = [
  "cuentas/movimientos",
  "cuentarut/movimientos",
  "movimientos/cartola",
  "cuentas/cartola",
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const AKAMAI_ERROR = [
  "BancoEstado bloqueado por Akamai (proteccion anti-bot).",
  "El servidor detecto que la conexion no proviene de un navegador real.",
  "Solucion: usa el modo browser con tu perfil de Chrome:",
  "  node dist/cli.js --bank bestado --headful --profile",
  "Esto usa tu sesion real de Chrome y evita el bloqueo de Akamai.",
].join("\n");

// ─── API response types (best-effort, no credentials to confirm) ─

interface ApiMovement {
  fecha?: string;
  fechaContable?: string;
  fechaTransaccion?: string;
  descripcion?: string;
  glosa?: string;
  detalle?: string;
  monto?: number;
  cargo?: number;
  abono?: number;
  saldo?: number;
  tipo?: string;
}

interface ApiBalanceResponse {
  saldoDisponible?: number;
  saldo?: number;
  disponible?: number;
  cuentas?: Array<{ saldo?: number; disponible?: number; tipo?: string; producto?: string }>;
}

interface ApiMovementsResponse {
  movimientos?: ApiMovement[];
  cartola?: ApiMovement[];
  data?: ApiMovement[];
  totalPaginas?: number;
  paginaActual?: number;
  masPaginas?: boolean;
  hasMore?: boolean;
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

// ─── Akamai detection ────────────────────────────────────────────

function isAkamaiBlock(status: number, body: string): boolean {
  if (status === 403) return true;
  if (status === 429) return true;
  // Akamai challenge pages contain specific markers
  const akamaiMarkers = [
    "akamai",
    "access denied",
    "reference #",
    "bot manager",
    "javascript is required",
    "_abck",
    "ak_bmsc",
    "challenge-platform",
  ];
  const lower = body.toLowerCase();
  return akamaiMarkers.some(marker => lower.includes(marker));
}

// ─── Login ───────────────────────────────────────────────────────

async function bestadoLogin(
  rut: string,
  password: string,
  debugLog: string[],
): Promise<{ success: true; jar: CookieJar; apiBase: string } | { success: false; error: string }> {
  const jar = createCookieJar();
  const cleanRut = rut.replace(/[.\-]/g, "");

  // Step 1: GET login page to collect cookies and detect Akamai
  debugLog.push("1. Fetching BancoEstado login page...");
  let loginPageBody: string;
  try {
    const loginPageRes = await fetch(LOGIN_PAGE, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-CL,es;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
    });
    jar.setAll(loginPageRes.headers);
    loginPageBody = await loginPageRes.text();
    debugLog.push(`  Status: ${loginPageRes.status}, cookies: ${jar.cookies.size}`);

    if (isAkamaiBlock(loginPageRes.status, loginPageBody)) {
      debugLog.push("  BLOCKED: Akamai detected on initial page load");
      return { success: false, error: AKAMAI_ERROR };
    }
  } catch (err) {
    debugLog.push(`  Network error: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, error: `No se pudo conectar a BancoEstado: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Step 2: Try to discover the login endpoint from the Angular SPA
  debugLog.push("2. Attempting API login...");

  // Extract any CSRF/XSRF tokens from cookies or page
  const xsrf = jar.get("XSRF-TOKEN") ? decodeURIComponent(jar.get("XSRF-TOKEN")!) : undefined;
  const csrfFromPage = loginPageBody.match(/name="csrf[^"]*"\s+(?:value|content)="([^"]+)"/i)?.[1]
    || loginPageBody.match(/csrf[_-]?token['"]\s*[:=]\s*['"]([^'"]+)/i)?.[1];
  const csrfToken = xsrf || csrfFromPage;

  // Build login payloads — try JSON first, then form-encoded
  const jsonPayload = JSON.stringify({ rut: cleanRut, password, clave: password });
  const formPayload = new URLSearchParams({
    rut: cleanRut,
    password,
    ...(csrfToken ? { _csrf: csrfToken } : {}),
  }).toString();

  let loginSuccess = false;
  let discoveredApiBase = "";

  for (const loginUrl of LOGIN_POST_CANDIDATES) {
    // Try JSON
    try {
      debugLog.push(`  Trying POST ${loginUrl} (JSON)...`);
      const res = await fetch(loginUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          Cookie: jar.header(),
          Referer: LOGIN_PAGE,
          Origin: "https://www.bancoestado.cl",
          ...(csrfToken ? { "X-XSRF-TOKEN": csrfToken, "X-CSRF-TOKEN": csrfToken } : {}),
        },
        body: jsonPayload,
        redirect: "manual",
      });
      jar.setAll(res.headers);
      const body = await res.text();
      debugLog.push(`    Status: ${res.status}`);

      if (isAkamaiBlock(res.status, body)) {
        debugLog.push("    BLOCKED: Akamai on login POST");
        return { success: false, error: AKAMAI_ERROR };
      }

      // 2xx or 3xx redirect = potentially successful
      if (res.status >= 200 && res.status < 400) {
        // Check if the response indicates success
        try {
          const json = JSON.parse(body);
          if (json.error || json.mensaje?.toLowerCase().includes("incorrecto") || json.mensaje?.toLowerCase().includes("invalido")) {
            debugLog.push(`    Login rejected: ${json.error || json.mensaje}`);
            return { success: false, error: `Credenciales incorrectas: ${json.error || json.mensaje}` };
          }
        } catch { /* not JSON, check redirect */ }

        const location = res.headers.get("location") || "";
        if (location && !location.includes("/login")) {
          loginSuccess = true;
          // Derive API base from login URL
          const urlObj = new URL(loginUrl);
          discoveredApiBase = `${urlObj.origin}/api`;
          debugLog.push(`    Login appears successful (redirect: ${location})`);

          // Follow redirect
          if (location) {
            try {
              const redirectUrl = location.startsWith("http") ? location : `${urlObj.origin}${location}`;
              const rRes = await fetch(redirectUrl, {
                headers: { "User-Agent": UA, Cookie: jar.header() },
                redirect: "follow",
              });
              jar.setAll(rRes.headers);
            } catch { /* ignore redirect errors */ }
          }
          break;
        }

        // If 200 with body that looks like a token or session
        if (res.status === 200 && body.length > 0 && body.length < 5000) {
          try {
            const json = JSON.parse(body);
            if (json.token || json.access_token || json.sessionId || json.success) {
              loginSuccess = true;
              const urlObj = new URL(loginUrl);
              discoveredApiBase = `${urlObj.origin}/api`;
              if (json.token) jar.cookies.set("Authorization", `Bearer ${json.token}`);
              if (json.access_token) jar.cookies.set("Authorization", `Bearer ${json.access_token}`);
              debugLog.push("    Login successful (token received)");
              break;
            }
          } catch { /* not JSON */ }
        }
      }
    } catch { /* network error, try next */ }

    // Try form-encoded
    try {
      debugLog.push(`  Trying POST ${loginUrl} (form)...`);
      const res = await fetch(loginUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "text/html,application/json,*/*",
          Cookie: jar.header(),
          Referer: LOGIN_PAGE,
          Origin: "https://www.bancoestado.cl",
          ...(csrfToken ? { "X-XSRF-TOKEN": csrfToken, "X-CSRF-TOKEN": csrfToken } : {}),
        },
        body: formPayload,
        redirect: "manual",
      });
      jar.setAll(res.headers);
      const body = await res.text();
      debugLog.push(`    Status: ${res.status}`);

      if (isAkamaiBlock(res.status, body)) {
        debugLog.push("    BLOCKED: Akamai on login POST");
        return { success: false, error: AKAMAI_ERROR };
      }

      const location = res.headers.get("location") || "";
      if (res.status >= 300 && res.status < 400 && location && !location.includes("/login")) {
        loginSuccess = true;
        const urlObj = new URL(loginUrl);
        discoveredApiBase = `${urlObj.origin}/api`;
        debugLog.push(`    Login appears successful (redirect: ${location})`);

        try {
          const redirectUrl = location.startsWith("http") ? location : `${urlObj.origin}${location}`;
          const rRes = await fetch(redirectUrl, {
            headers: { "User-Agent": UA, Cookie: jar.header() },
            redirect: "follow",
          });
          jar.setAll(rRes.headers);
        } catch { /* ignore */ }
        break;
      }
    } catch { /* network error, try next */ }
  }

  if (!loginSuccess) {
    debugLog.push("  All login endpoints failed or were blocked");
    return {
      success: false,
      error: [
        "No se pudo autenticar con BancoEstado via API.",
        "Los endpoints de login conocidos no respondieron correctamente.",
        "Posibles causas:",
        "  - Akamai bloquea conexiones que no provienen de un navegador real",
        "  - Los endpoints de login han cambiado",
        "Solucion: usa el modo browser con tu perfil de Chrome:",
        "  node dist/cli.js --bank bestado --headful --profile",
      ].join("\n"),
    };
  }

  // Determine working API base
  if (!discoveredApiBase) discoveredApiBase = API_BASE_CANDIDATES[0];
  debugLog.push(`3. Login OK, API base: ${discoveredApiBase}, cookies: ${jar.cookies.size}`);

  return { success: true, jar, apiBase: discoveredApiBase };
}

// ─── API helpers ─────────────────────────────────────────────────

async function apiGet<T>(jar: CookieJar, url: string): Promise<T> {
  const xsrf = jar.get("XSRF-TOKEN") ? decodeURIComponent(jar.get("XSRF-TOKEN")!) : undefined;
  const authCookie = jar.get("Authorization");
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: "https://www.bancoestado.cl/",
      Origin: "https://www.bancoestado.cl",
      ...(xsrf ? { "X-XSRF-TOKEN": xsrf } : {}),
      ...(authCookie ? { Authorization: authCookie } : {}),
    },
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API GET ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(jar: CookieJar, url: string, body: unknown = {}): Promise<T> {
  const xsrf = jar.get("XSRF-TOKEN") ? decodeURIComponent(jar.get("XSRF-TOKEN")!) : undefined;
  const authCookie = jar.get("Authorization");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: "https://www.bancoestado.cl/",
      Origin: "https://www.bancoestado.cl",
      ...(xsrf ? { "X-XSRF-TOKEN": xsrf } : {}),
      ...(authCookie ? { Authorization: authCookie } : {}),
    },
    body: JSON.stringify(body),
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API POST ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Data extraction ─────────────────────────────────────────────

function parseApiMovement(mov: ApiMovement): BankMovement | null {
  const dateRaw = mov.fecha || mov.fechaContable || mov.fechaTransaccion;
  if (!dateRaw) return null;

  const description = (mov.descripcion || mov.glosa || mov.detalle || "").trim();
  if (!description) return null;

  let amount: number;
  if (mov.monto !== undefined) {
    // If tipo indicates cargo (debit), make negative
    amount = mov.tipo === "cargo" || mov.tipo === "debito" ? -Math.abs(mov.monto) : Math.abs(mov.monto);
  } else if (mov.cargo !== undefined && mov.cargo !== 0) {
    amount = -Math.abs(mov.cargo);
  } else if (mov.abono !== undefined && mov.abono !== 0) {
    amount = Math.abs(mov.abono);
  } else {
    return null;
  }

  return {
    date: normalizeDate(dateRaw),
    description,
    amount,
    balance: mov.saldo ?? 0,
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── Balance fetching ────────────────────────────────────────────

async function fetchBalance(
  jar: CookieJar,
  apiBase: string,
  debugLog: string[],
): Promise<number | undefined> {
  for (const path of BALANCE_PATHS) {
    const url = `${apiBase}/${path}`;
    try {
      // Try GET first
      const data = await apiGet<ApiBalanceResponse>(jar, url);
      if (data.saldoDisponible !== undefined) return data.saldoDisponible;
      if (data.disponible !== undefined) return data.disponible;
      if (data.saldo !== undefined) return data.saldo;
      if (data.cuentas?.length) {
        const cuentaRut = data.cuentas.find(c =>
          c.tipo?.toLowerCase().includes("cuentarut") ||
          c.producto?.toLowerCase().includes("cuentarut") ||
          c.tipo?.toLowerCase().includes("cuenta rut"),
        );
        const acct = cuentaRut || data.cuentas[0];
        return acct.disponible ?? acct.saldo;
      }
      debugLog.push(`  Balance from ${path}: found data but no recognized fields`);
    } catch {
      // Try POST as fallback
      try {
        const data = await apiPost<ApiBalanceResponse>(jar, url, {});
        if (data.saldoDisponible !== undefined) return data.saldoDisponible;
        if (data.disponible !== undefined) return data.disponible;
        if (data.saldo !== undefined) return data.saldo;
      } catch { /* try next path */ }
    }
  }
  return undefined;
}

// ─── Movements fetching ──────────────────────────────────────────

async function fetchMovements(
  jar: CookieJar,
  apiBase: string,
  debugLog: string[],
): Promise<BankMovement[]> {
  const allMovements: BankMovement[] = [];

  for (const path of MOVEMENTS_PATHS) {
    const url = `${apiBase}/${path}`;
    try {
      // Try GET first
      let data: ApiMovementsResponse;
      try {
        data = await apiGet<ApiMovementsResponse>(jar, url);
      } catch {
        // Try POST with empty body or pagination params
        data = await apiPost<ApiMovementsResponse>(jar, url, { pagina: 1, cantidad: 50 });
      }

      const movList = data.movimientos || data.cartola || data.data || [];
      if (movList.length === 0) continue;

      debugLog.push(`  Found ${movList.length} movements from ${path}`);
      for (const mov of movList) {
        const parsed = parseApiMovement(mov);
        if (parsed) allMovements.push(parsed);
      }

      // Pagination
      let hasMore = data.masPaginas ?? data.hasMore ?? ((data.totalPaginas ?? 1) > (data.paginaActual ?? 1));
      let page = 2;
      while (hasMore && page <= 25) {
        try {
          const nextData = await apiPost<ApiMovementsResponse>(jar, url, { pagina: page, cantidad: 50 });
          const nextList = nextData.movimientos || nextData.cartola || nextData.data || [];
          if (nextList.length === 0) break;

          debugLog.push(`  Page ${page}: ${nextList.length} movements`);
          for (const mov of nextList) {
            const parsed = parseApiMovement(mov);
            if (parsed) allMovements.push(parsed);
          }

          hasMore = nextData.masPaginas ?? nextData.hasMore ?? ((nextData.totalPaginas ?? 1) > page);
          page++;
        } catch {
          hasMore = false;
        }
      }

      // If we got movements from this path, stop trying others
      break;
    } catch { /* try next path */ }
  }

  return allMovements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBestado(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const bank = "bestado";
  const progress = onProgress || (() => {});

  // Step 1: Login
  progress("Conectando con BancoEstado API...");
  const loginResult = await bestadoLogin(rut, password, debugLog);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar, apiBase } = loginResult;
  progress("Sesion iniciada correctamente");

  // Step 2: Fetch balance
  debugLog.push("4. Fetching CuentaRUT balance...");
  progress("Obteniendo saldo CuentaRUT...");
  let balance: number | undefined;
  try {
    balance = await fetchBalance(jar, apiBase, debugLog);
    if (balance !== undefined) {
      debugLog.push(`  CuentaRUT balance: $${balance.toLocaleString("es-CL")}`);
    } else {
      debugLog.push("  Could not find balance from any endpoint");
    }
  } catch (err) {
    debugLog.push(`  Balance error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Also try alternate API bases if primary didn't yield balance
  if (balance === undefined) {
    for (const altBase of API_BASE_CANDIDATES) {
      if (altBase === apiBase) continue;
      try {
        balance = await fetchBalance(jar, altBase, debugLog);
        if (balance !== undefined) {
          debugLog.push(`  Balance found via alternate base: ${altBase}`);
          break;
        }
      } catch { /* try next */ }
    }
  }

  // Step 3: Fetch movements
  debugLog.push("5. Fetching CuentaRUT movements...");
  progress("Extrayendo movimientos CuentaRUT...");
  let movements: BankMovement[] = [];
  try {
    movements = await fetchMovements(jar, apiBase, debugLog);
  } catch (err) {
    debugLog.push(`  Movements error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Try alternate API bases if no movements found
  if (movements.length === 0) {
    for (const altBase of API_BASE_CANDIDATES) {
      if (altBase === apiBase) continue;
      try {
        movements = await fetchMovements(jar, altBase, debugLog);
        if (movements.length > 0) {
          debugLog.push(`  Movements found via alternate base: ${altBase}`);
          break;
        }
      } catch { /* try next */ }
    }
  }

  // Deduplicate
  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`6. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos totales`);

  // Derive balance from first movement if not found via API
  if (balance === undefined && deduplicated.length > 0) {
    const withBalance = deduplicated.find(m => m.balance !== 0);
    if (withBalance) {
      balance = withBalance.balance;
      debugLog.push(`  Balance derived from movements: $${balance.toLocaleString("es-CL")}`);
    }
  }

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const bestado: BankScraper = {
  id: "bestado",
  name: "Banco Estado",
  url: "https://www.bancoestado.cl",
  mode: "api",
  scrape: (options) => runApiScraper("bestado", options, scrapeBestado),
};

export default bestado;
