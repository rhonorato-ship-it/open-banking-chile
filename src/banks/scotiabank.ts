import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Scotiabank constants ───────────────────────────────────────
//
// Auth: Form-based login at personas.scotiabank.cl
// Data: REST API at personas.scotiabank.cl (JSON endpoints)
//
// No browser needed — this scraper uses fetch() exclusively.

const BANK_URL = "https://www.scotiabank.cl";
const LOGIN_PAGE = "https://personas.scotiabank.cl/scotiabank-web/personas/login";
const LOGIN_POST_CANDIDATES = [
  "https://personas.scotiabank.cl/api/auth/login",
  "https://personas.scotiabank.cl/scotiabank-web/personas/api/auth/login",
  "https://personas.scotiabank.cl/api/login",
  "https://personas.scotiabank.cl/scotiabank-web/personas/login",
];
const API_BASE = "https://personas.scotiabank.cl/api";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── API types ───────────────────────────────────────────────────

interface ApiAccount {
  id?: string;
  numero?: string;
  mascara?: string;
  tipo?: string;
  moneda?: string;
  saldo?: number;
  saldoDisponible?: number;
  descripcion?: string;
}

interface ApiMovement {
  fecha?: string;
  fechaContable?: string;
  descripcion?: string;
  glosa?: string;
  cargo?: number;
  abono?: number;
  monto?: number;
  saldo?: number;
  tipo?: string;
}

interface ApiMovementsResponse {
  movimientos?: ApiMovement[];
  pagina?: number;
  totalPaginas?: number;
  masPaginas?: boolean;
  totalRegistros?: number;
}

// ─── Cookie jar ──────────────────────────────────────────────────

interface CookieJar {
  cookies: Map<string, string>;
  set(raw: string): void;
  setAll(headers: Headers): void;
  header(): string;
  csrf(): string;
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
    csrf() {
      // Try common CSRF cookie names
      return decodeURIComponent(
        cookies.get("XSRF-TOKEN") ?? cookies.get("csrf-token") ?? cookies.get("_csrf") ?? "",
      );
    },
  };
}

// ─── Login ───────────────────────────────────────────────────────

async function scotiaLogin(
  rut: string,
  password: string,
  debugLog: string[],
  onTwoFactorCode?: () => Promise<string>,
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  const jar = createCookieJar();

  // Step 1: GET login page to collect pre-auth cookies
  debugLog.push("1. Fetching Scotiabank login page...");
  const loginPageRes = await fetch(LOGIN_PAGE, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  jar.setAll(loginPageRes.headers);
  debugLog.push(`  Status: ${loginPageRes.status}, cookies: ${jar.cookies.size}`);

  // Also GET main bank URL for additional cookies
  const mainPageRes = await fetch(BANK_URL, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  jar.setAll(mainPageRes.headers);

  // Step 2: Try login POST to candidate endpoints
  debugLog.push("2. Submitting credentials...");
  const formattedRut = formatRut(rut);
  const csrf = jar.csrf();

  let loginSuccess = false;
  let loginError = "";

  for (const loginUrl of LOGIN_POST_CANDIDATES) {
    debugLog.push(`  Trying: ${loginUrl}`);

    // Try JSON body first
    try {
      const jsonRes = await fetch(loginUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: jar.header(),
          Referer: LOGIN_PAGE,
          Origin: "https://personas.scotiabank.cl",
          ...(csrf ? { "X-XSRF-TOKEN": csrf, "X-CSRF-TOKEN": csrf } : {}),
        },
        body: JSON.stringify({ rut: formattedRut, password }),
        redirect: "manual",
      });
      jar.setAll(jsonRes.headers);

      const status = jsonRes.status;
      debugLog.push(`    JSON POST → ${status}`);

      if (status >= 200 && status < 400 && status !== 401 && status !== 403) {
        // Check for 2FA requirement in response
        if (status === 200 || status === 302) {
          let responseBody: Record<string, unknown> = {};
          try { responseBody = await jsonRes.json() as Record<string, unknown>; } catch { /* not JSON */ }

          const bodyStr = JSON.stringify(responseBody).toLowerCase();
          if (bodyStr.includes("clave dinámica") || bodyStr.includes("segundo factor") ||
              bodyStr.includes("código de verificación") || bodyStr.includes("token") ||
              bodyStr.includes("2fa") || bodyStr.includes("otp") ||
              (responseBody.requires2FA === true) || (responseBody.requiresOtp === true)) {
            debugLog.push("  2FA required");
            if (!onTwoFactorCode) {
              return { success: false, error: "El banco pide clave dinámica o 2FA y no se proporcionó callback." };
            }
            const code = await onTwoFactorCode();
            debugLog.push("  Submitting 2FA code...");

            // Try submitting 2FA code
            const twoFaUrls = [
              `${API_BASE}/auth/2fa`,
              `${API_BASE}/auth/verify`,
              `${API_BASE}/auth/otp`,
              loginUrl.replace("/login", "/2fa"),
            ];
            let twoFaSuccess = false;
            for (const twoFaUrl of twoFaUrls) {
              try {
                const twoFaRes = await fetch(twoFaUrl, {
                  method: "POST",
                  headers: {
                    "User-Agent": UA,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Cookie: jar.header(),
                    Referer: LOGIN_PAGE,
                    Origin: "https://personas.scotiabank.cl",
                    ...(jar.csrf() ? { "X-XSRF-TOKEN": jar.csrf(), "X-CSRF-TOKEN": jar.csrf() } : {}),
                  },
                  body: JSON.stringify({ code, otp: code, token: code }),
                  redirect: "manual",
                });
                jar.setAll(twoFaRes.headers);
                if (twoFaRes.status >= 200 && twoFaRes.status < 400) {
                  twoFaSuccess = true;
                  debugLog.push(`    2FA accepted at ${twoFaUrl}`);
                  break;
                }
              } catch { /* try next */ }
            }
            if (!twoFaSuccess) {
              return { success: false, error: "No se pudo validar la clave dinámica (2FA)." };
            }
          }

          // Check for explicit login error
          if (responseBody.error || responseBody.mensaje?.toString().toLowerCase().includes("incorrecto")) {
            loginError = String(responseBody.error || responseBody.mensaje || "Credenciales incorrectas");
            continue;
          }
        }

        loginSuccess = true;
        debugLog.push(`    Login accepted at ${loginUrl}`);
        break;
      }
    } catch { /* try next format */ }

    // Try form-encoded body
    try {
      const formBody = new URLSearchParams({
        rut: formattedRut,
        password,
        ...(csrf ? { _csrf: csrf } : {}),
      });
      const formRes = await fetch(loginUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: jar.header(),
          Referer: LOGIN_PAGE,
          ...(csrf ? { "X-XSRF-TOKEN": csrf } : {}),
        },
        body: formBody.toString(),
        redirect: "manual",
      });
      jar.setAll(formRes.headers);

      const status = formRes.status;
      const location = formRes.headers.get("location") || "";
      debugLog.push(`    Form POST → ${status}, Location: ${location}`);

      // 302 redirect to portal = success, 302 to login = failure
      if (status === 302 && !location.includes("login") && !location.includes("error")) {
        // Follow redirect to collect session cookies
        const redirectUrl = location.startsWith("http") ? location : `https://personas.scotiabank.cl${location}`;
        const redirectRes = await fetch(redirectUrl, {
          headers: { "User-Agent": UA, Cookie: jar.header() },
          redirect: "follow",
        });
        jar.setAll(redirectRes.headers);
        loginSuccess = true;
        debugLog.push(`    Login accepted (form) at ${loginUrl}`);
        break;
      }

      if (status === 200) {
        // Could be success (JSON API) or failure (re-rendered login page)
        try {
          const body = await formRes.json() as Record<string, unknown>;
          if (!body.error && !String(body.mensaje ?? "").toLowerCase().includes("incorrecto")) {
            loginSuccess = true;
            debugLog.push(`    Login accepted (form 200) at ${loginUrl}`);
            break;
          }
          loginError = String(body.error || body.mensaje || "");
        } catch { /* not JSON, likely rendered login page = failure */ }
      }
    } catch { /* try next endpoint */ }
  }

  if (!loginSuccess) {
    return { success: false, error: loginError || "Credenciales incorrectas o no se encontró endpoint de login." };
  }

  debugLog.push(`3. Login OK! Cookies: ${Array.from(jar.cookies.keys()).join(", ")}`);
  return { success: true, jar };
}

// ─── API helpers ─────────────────────────────────────────────────

async function apiGet<T>(jar: CookieJar, path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: LOGIN_PAGE,
      Origin: "https://personas.scotiabank.cl",
      ...(jar.csrf() ? { "X-XSRF-TOKEN": jar.csrf(), "X-CSRF-TOKEN": jar.csrf() } : {}),
    },
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(jar: CookieJar, path: string, body: unknown = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: LOGIN_PAGE,
      Origin: "https://personas.scotiabank.cl",
      ...(jar.csrf() ? { "X-XSRF-TOKEN": jar.csrf(), "X-CSRF-TOKEN": jar.csrf() } : {}),
    },
    body: JSON.stringify(body),
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API POST ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Data extraction ─────────────────────────────────────────────

function apiMovToMovement(mov: ApiMovement): BankMovement {
  const date = normalizeDate(mov.fecha || mov.fechaContable || "");
  const description = (mov.descripcion || mov.glosa || "").trim();

  let amount: number;
  if (mov.cargo !== undefined && mov.cargo !== null && mov.cargo !== 0) {
    amount = -Math.abs(mov.cargo);
  } else if (mov.abono !== undefined && mov.abono !== null && mov.abono !== 0) {
    amount = Math.abs(mov.abono);
  } else if (mov.monto !== undefined && mov.monto !== null) {
    // If tipo is available, use it to determine sign
    if (mov.tipo === "cargo" || mov.tipo === "debito") {
      amount = -Math.abs(mov.monto);
    } else if (mov.tipo === "abono" || mov.tipo === "credito") {
      amount = Math.abs(mov.monto);
    } else {
      amount = mov.monto; // preserve original sign
    }
  } else {
    amount = 0;
  }

  return {
    date,
    description,
    amount,
    balance: mov.saldo ?? 0,
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── Fetch movements ─────────────────────────────────────────────

async function fetchMovements(
  jar: CookieJar,
  account: ApiAccount,
  debugLog: string[],
  startDate?: string,
  endDate?: string,
): Promise<BankMovement[]> {
  const movements: BankMovement[] = [];
  const accountId = account.id || account.numero || "";

  // Try multiple endpoint patterns
  const endpointCandidates = [
    `cuentas/${accountId}/movimientos`,
    `cuentas/movimientos`,
    `movimientos/cuenta/${accountId}`,
    `movimientos`,
  ];

  for (const endpoint of endpointCandidates) {
    try {
      // Build query params
      const params: Record<string, string> = {};
      if (accountId) params.cuenta = accountId;
      if (startDate) params.fechaDesde = startDate;
      if (endDate) params.fechaHasta = endDate;
      params.pagina = "1";

      const queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
      const url = `${endpoint}?${queryString}`;

      const response = await apiGet<ApiMovementsResponse | ApiMovement[]>(jar, url);

      // Handle array response
      if (Array.isArray(response)) {
        for (const mov of response) {
          const m = apiMovToMovement(mov);
          if (m.amount !== 0) movements.push(m);
        }
        debugLog.push(`  Fetched ${response.length} movements from ${endpoint}`);
        break;
      }

      // Handle paginated response
      if (response.movimientos) {
        for (const mov of response.movimientos) {
          const m = apiMovToMovement(mov);
          if (m.amount !== 0) movements.push(m);
        }
        debugLog.push(`  Page 1: ${response.movimientos.length} movements from ${endpoint}`);

        // Paginate
        const totalPages = response.totalPaginas ?? (response.masPaginas ? 25 : 1);
        for (let page = 2; page <= Math.min(totalPages, 25); page++) {
          if (response.masPaginas === false && !response.totalPaginas) break;
          try {
            params.pagina = String(page);
            const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
            const pageResponse = await apiGet<ApiMovementsResponse>(jar, `${endpoint}?${qs}`);
            if (!pageResponse.movimientos?.length) break;
            for (const mov of pageResponse.movimientos) {
              const m = apiMovToMovement(mov);
              if (m.amount !== 0) movements.push(m);
            }
            debugLog.push(`  Page ${page}: ${pageResponse.movimientos.length} movements`);
            if (pageResponse.masPaginas === false) break;
          } catch { break; }
        }
        break;
      }
    } catch { /* try next endpoint */ }
  }

  // Also try POST-based movement fetch if GET yielded nothing
  if (movements.length === 0) {
    const postEndpoints = [
      "cuentas/movimientos",
      "movimientos/consultar",
      "movimientos/getCartola",
    ];
    for (const endpoint of postEndpoints) {
      try {
        const body: Record<string, unknown> = { cuenta: accountId };
        if (account.numero) body.numeroCuenta = account.numero;
        if (startDate) body.fechaDesde = startDate;
        if (endDate) body.fechaHasta = endDate;
        body.pagina = 1;

        const response = await apiPost<ApiMovementsResponse | ApiMovement[]>(jar, endpoint, body);

        if (Array.isArray(response)) {
          for (const mov of response) {
            const m = apiMovToMovement(mov);
            if (m.amount !== 0) movements.push(m);
          }
          debugLog.push(`  POST ${endpoint}: ${response.length} movements`);
          break;
        }
        if (response.movimientos?.length) {
          for (const mov of response.movimientos) {
            const m = apiMovToMovement(mov);
            if (m.amount !== 0) movements.push(m);
          }
          debugLog.push(`  POST ${endpoint}: ${response.movimientos.length} movements`);

          // Paginate POST
          let hasMore = (response.masPaginas ?? false) || ((response.totalPaginas ?? 1) > 1);
          for (let page = 2; hasMore && page <= 25; page++) {
            try {
              body.pagina = page;
              const pageRes = await apiPost<ApiMovementsResponse>(jar, endpoint, body);
              if (!pageRes.movimientos?.length) break;
              for (const mov of pageRes.movimientos) {
                const m = apiMovToMovement(mov);
                if (m.amount !== 0) movements.push(m);
              }
              hasMore = (pageRes.masPaginas ?? false) || (page < (pageRes.totalPaginas ?? 1));
            } catch { hasMore = false; }
          }
          break;
        }
      } catch { /* try next */ }
    }
  }

  return movements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeScotiabank(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress, onTwoFactorCode } = options;
  const bank = "scotiabank";
  const progress = onProgress || (() => {});

  // Step 1: Login
  progress("Conectando con Scotiabank API...");
  const loginResult = await scotiaLogin(rut, password, debugLog, onTwoFactorCode);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar } = loginResult;
  progress("Sesion iniciada correctamente");

  // Step 2: Fetch accounts
  debugLog.push("4. Fetching accounts...");
  progress("Obteniendo cuentas...");

  let accounts: ApiAccount[] = [];
  const accountEndpoints = ["cuentas", "cuentas/lista", "productos/cuentas", "productos"];
  for (const endpoint of accountEndpoints) {
    try {
      const response = await apiGet<ApiAccount[] | { cuentas?: ApiAccount[]; productos?: ApiAccount[] }>(jar, endpoint);
      if (Array.isArray(response)) {
        accounts = response;
      } else if (response.cuentas) {
        accounts = response.cuentas;
      } else if (response.productos) {
        accounts = response.productos.filter(p => p.tipo === "cuenta" || p.tipo === "cuentaCorriente" || p.tipo === "cuentaVista");
      }
      if (accounts.length > 0) {
        debugLog.push(`  Found ${accounts.length} account(s) from ${endpoint}`);
        break;
      }
    } catch { /* try next */ }
  }

  // Step 3: Fetch balance
  let balance: number | undefined;

  // Try dedicated balance endpoint
  const balanceEndpoints = ["cuentas/saldos", "saldos", "productos/saldos"];
  for (const endpoint of balanceEndpoints) {
    try {
      const response = await apiGet<Array<{ moneda?: string; saldo?: number; disponible?: number; saldoDisponible?: number }> | { saldo?: number; disponible?: number }>(jar, endpoint);
      if (Array.isArray(response)) {
        const clp = response.find(s => s.moneda === "CLP" || !s.moneda);
        if (clp) balance = clp.disponible ?? clp.saldoDisponible ?? clp.saldo;
      } else if (response.saldo !== undefined || response.disponible !== undefined) {
        balance = response.disponible ?? response.saldo;
      }
      if (balance !== undefined) {
        debugLog.push(`  Balance: $${balance}`);
        break;
      }
    } catch { /* try next */ }
  }

  // Also try balance from accounts
  if (balance === undefined && accounts.length > 0) {
    const acct = accounts.find(a => a.moneda === "CLP" || !a.moneda);
    if (acct) balance = acct.saldoDisponible ?? acct.saldo;
  }

  // Step 4: Fetch movements for current period
  debugLog.push("5. Fetching movements (current period)...");
  progress("Extrayendo movimientos de cuenta...");

  const allMovements: BankMovement[] = [];

  if (accounts.length > 0) {
    for (const account of accounts) {
      const acctMovs = await fetchMovements(jar, account, debugLog);
      allMovements.push(...acctMovs);
    }
  } else {
    // If no accounts found, try fetching movements directly (some APIs don't need account selection)
    const defaultAccount: ApiAccount = { id: "", numero: "" };
    const movs = await fetchMovements(jar, defaultAccount, debugLog);
    allMovements.push(...movs);
  }

  debugLog.push(`  Current period: ${allMovements.length} movements`);
  progress(`Periodo actual: ${allMovements.length} movimientos`);

  // Step 5: Historical periods (SCOTIABANK_MONTHS env var)
  const months = Math.min(Math.max(parseInt(process.env.SCOTIABANK_MONTHS || "0", 10) || 0, 0), 12);
  if (months > 0) {
    debugLog.push(`6. Fetching ${months} historical period(s)...`);
    progress(`Extrayendo ${months} periodo(s) historico(s)...`);

    const now = new Date();
    for (let m = 0; m < months; m++) {
      const target = new Date(now.getFullYear(), now.getMonth() - (m + 1), 1);
      const firstDay = new Date(target.getFullYear(), target.getMonth(), 1);
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0);

      const fmt = (d: Date) =>
        `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

      debugLog.push(`  Period -${m + 1}: ${fmt(firstDay)} to ${fmt(lastDay)}`);

      for (const account of accounts.length > 0 ? accounts : [{ id: "", numero: "" }]) {
        const periodMovs = await fetchMovements(jar, account, debugLog, fmt(firstDay), fmt(lastDay));
        allMovements.push(...periodMovs);
        debugLog.push(`    ${periodMovs.length} movements`);
      }
    }
  }

  // Step 6: Balance fallback from movements
  if (balance === undefined && allMovements.length > 0 && allMovements[0].balance > 0) {
    balance = allMovements[0].balance;
  }

  // Deduplicate and return
  const deduplicated = deduplicateMovements(allMovements);
  debugLog.push(`7. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance: balance ?? undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const scotiabank: BankScraper = {
  id: "scotiabank",
  name: "Scotiabank Chile",
  url: BANK_URL,
  mode: "api",
  scrape: (options) => runApiScraper("scotiabank", options, scrapeScotiabank),
};

export default scotiabank;
