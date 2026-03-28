import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements, normalizeInstallments, normalizeOwner } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Banco Falabella constants ──────────────────────────────────
//
// Auth: Angular SPA with session-cookie auth
// Data: REST API behind the authenticated portal
// 2FA: SMS-based second factor
//
// No browser needed — this scraper uses fetch() exclusively.

const BANK_URL = "https://www.bancofalabella.cl";
const LOGIN_PAGE = "https://www.bancofalabella.cl/personas";
const API_BASE = "https://www.bancofalabella.cl/api";

// Candidate login endpoints (Angular SPA — exact path requires network inspection)
const LOGIN_ENDPOINTS = [
  "/api/auth/login",
  "/api/login",
  "/personas/api/auth",
  "/api/v1/auth/login",
];

// Candidate form-login fallback
const FORM_LOGIN = "/personas/login";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── API types ───────────────────────────────────────────────────

interface ApiAccountProduct {
  id: string;
  number: string;
  type: string;
  currency: string;
  label: string;
  balance?: number;
}

interface ApiAccountMovement {
  date: string;
  description: string;
  amount: number;
  balance: number;
  type: string; // "cargo" | "abono"
}

interface ApiCreditCard {
  id: string;
  number: string;
  brand: string;
  type: string;
  holder: string;
}

interface ApiCardBalance {
  totalNational: number;
  usedNational: number;
  availableNational: number;
  totalInternational?: number;
  usedInternational?: number;
  availableInternational?: number;
}

interface ApiUnbilledMovement {
  date: string;
  description: string;
  amount: number;
  installments?: string;
  owner?: string;
}

interface ApiBilledMovement {
  date: string;
  description: string;
  amount: number;
  installments?: string;
  owner?: string;
  group?: string;
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

// ─── Helpers ─────────────────────────────────────────────────────

function cleanRut(rut: string): string {
  return rut.replace(/[.\-\s]/g, "");
}

function commonHeaders(jar: CookieJar): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Cookie: jar.header(),
    Referer: LOGIN_PAGE,
    Origin: BANK_URL,
  };
  // Include CSRF/XSRF tokens if present
  const xsrf = jar.get("XSRF-TOKEN");
  if (xsrf) headers["X-XSRF-TOKEN"] = decodeURIComponent(xsrf);
  const csrf = jar.get("csrf-token");
  if (csrf) headers["X-CSRF-TOKEN"] = decodeURIComponent(csrf);
  return headers;
}

// ─── Login ───────────────────────────────────────────────────────

async function falabellaLogin(
  rut: string,
  password: string,
  debugLog: string[],
  onTwoFactorCode?: () => Promise<string>,
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  const jar = createCookieJar();
  const cleanedRut = cleanRut(rut);

  // Step 1: GET homepage to collect initial cookies
  debugLog.push("1. Fetching bank homepage for cookies...");
  const homepageRes = await fetch(BANK_URL, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  jar.setAll(homepageRes.headers);
  debugLog.push(`   Status: ${homepageRes.status}, cookies: ${jar.cookies.size}`);

  // Also fetch login page if different
  const loginPageRes = await fetch(LOGIN_PAGE, {
    headers: { "User-Agent": UA, Cookie: jar.header() },
    redirect: "follow",
  });
  jar.setAll(loginPageRes.headers);
  debugLog.push(`   Login page status: ${loginPageRes.status}, cookies: ${jar.cookies.size}`);

  // Step 2: Try JSON login endpoints
  debugLog.push("2. Attempting JSON login...");
  let loginSuccess = false;

  for (const endpoint of LOGIN_ENDPOINTS) {
    const url = `${BANK_URL}${endpoint}`;
    debugLog.push(`   Trying: ${endpoint}`);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...commonHeaders(jar),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rut: cleanedRut, password }),
        redirect: "manual",
      });
      jar.setAll(res.headers);

      if (res.status === 401 || res.status === 403) {
        const body = await res.text().catch(() => "");
        if (body.toLowerCase().includes("clave") || body.toLowerCase().includes("invalid") || body.toLowerCase().includes("incorrec")) {
          return { success: false, error: "Credenciales incorrectas (RUT o clave inválida)." };
        }
        debugLog.push(`     → ${res.status} (trying next)`);
        continue;
      }

      if (res.status === 404 || res.status === 405) {
        debugLog.push(`     → ${res.status} (endpoint not found)`);
        continue;
      }

      // Check for 2FA requirement
      if (res.status === 200 || res.status === 302) {
        const body = await res.text().catch(() => "");

        if (body.includes("segundo factor") || body.includes("clave dinámica") || body.includes("sms") || body.includes("2fa") || body.includes("otp")) {
          debugLog.push("   2FA required - sending code...");

          if (!onTwoFactorCode) {
            return { success: false, error: "El banco pide clave dinámica (2FA) pero no se proporcionó handler." };
          }

          const code = await onTwoFactorCode();
          const twoFaEndpoints = [
            `${endpoint}/2fa`,
            `${endpoint}/verify`,
            "/api/auth/2fa",
            "/api/auth/verify-otp",
          ];

          let twoFaSuccess = false;
          for (const tfEndpoint of twoFaEndpoints) {
            try {
              const tfUrl = `${BANK_URL}${tfEndpoint}`;
              const tfRes = await fetch(tfUrl, {
                method: "POST",
                headers: {
                  ...commonHeaders(jar),
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ code, otp: code }),
                redirect: "manual",
              });
              jar.setAll(tfRes.headers);

              if (tfRes.status === 200 || tfRes.status === 302) {
                twoFaSuccess = true;
                debugLog.push(`     2FA verified via ${tfEndpoint}`);
                break;
              }
            } catch {
              continue;
            }
          }

          if (!twoFaSuccess) {
            return { success: false, error: "No se pudo verificar el código 2FA." };
          }
        }

        loginSuccess = true;
        debugLog.push(`     → Login OK via ${endpoint} (status: ${res.status})`);
        break;
      }
    } catch {
      debugLog.push(`     → Error connecting to ${endpoint}`);
      continue;
    }
  }

  // Step 3: Fallback — form-urlencoded POST
  if (!loginSuccess) {
    debugLog.push("3. Trying form-urlencoded fallback...");
    try {
      const formBody = new URLSearchParams({
        rut: cleanedRut,
        password,
      });

      // Add CSRF if present
      const xsrf = jar.get("XSRF-TOKEN");
      if (xsrf) formBody.set("_csrf", decodeURIComponent(xsrf));

      const res = await fetch(`${BANK_URL}${FORM_LOGIN}`, {
        method: "POST",
        headers: {
          ...commonHeaders(jar),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formBody.toString(),
        redirect: "follow",
      });
      jar.setAll(res.headers);

      const responseUrl = res.url;
      const bodyText = await res.text().catch(() => "");

      // Check for login failure indicators
      if (bodyText.toLowerCase().includes("error") && bodyText.toLowerCase().includes("clave")) {
        return { success: false, error: "Credenciales incorrectas (RUT o clave inválida)." };
      }

      // Check for 2FA
      if (bodyText.includes("segundo factor") || bodyText.includes("clave dinámica")) {
        if (!onTwoFactorCode) {
          return { success: false, error: "El banco pide clave dinámica (2FA) pero no se proporcionó handler." };
        }
        return { success: false, error: "El banco pide clave dinámica (2FA). Flujo form-login 2FA no implementado." };
      }

      // Check for successful redirect to dashboard
      if (res.status === 200 && !responseUrl.includes("/login")) {
        loginSuccess = true;
        debugLog.push(`   Form login OK (redirected to ${responseUrl})`);
      } else {
        debugLog.push(`   Form login response: ${res.status}, url: ${responseUrl}`);
      }
    } catch (err) {
      debugLog.push(`   Form login error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!loginSuccess) {
    return { success: false, error: "No se pudo autenticar. Ningún endpoint de login respondió exitosamente." };
  }

  debugLog.push(`4. Login complete. Cookies: ${Array.from(jar.cookies.keys()).join(", ")}`);
  return { success: true, jar };
}

// ─── API helpers ─────────────────────────────────────────────────

async function apiGet<T>(jar: CookieJar, path: string, debugLog: string[]): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const res = await fetch(url, {
    headers: commonHeaders(jar),
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(jar: CookieJar, path: string, body: unknown = {}, debugLog: string[]): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...commonHeaders(jar),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API POST ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// Try multiple candidate endpoints, return first successful response
async function tryEndpoints<T>(jar: CookieJar, endpoints: string[], method: "GET" | "POST", body: unknown | undefined, debugLog: string[]): Promise<{ data: T; endpoint: string } | null> {
  for (const ep of endpoints) {
    try {
      const data = method === "GET"
        ? await apiGet<T>(jar, ep, debugLog)
        : await apiPost<T>(jar, ep, body, debugLog);
      debugLog.push(`   Found data at ${ep}`);
      return { data, endpoint: ep };
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Data extraction ─────────────────────────────────────────────

function toAccountMovement(mov: ApiAccountMovement): BankMovement {
  const amount = mov.type === "cargo" ? -Math.abs(mov.amount) : Math.abs(mov.amount);
  return {
    date: normalizeDate(mov.date),
    description: mov.description.trim(),
    amount,
    balance: mov.balance,
    source: MOVEMENT_SOURCE.account,
  };
}

function toUnbilledMovement(mov: ApiUnbilledMovement): BankMovement {
  // Credit card purchases are negative (charges)
  const amount = mov.amount < 0 ? Math.abs(mov.amount) : -Math.abs(mov.amount);
  return {
    date: normalizeDate(mov.date),
    description: mov.description.trim(),
    amount,
    balance: 0,
    source: MOVEMENT_SOURCE.credit_card_unbilled,
    owner: normalizeOwner(mov.owner),
    installments: normalizeInstallments(mov.installments),
  };
}

function toBilledMovement(mov: ApiBilledMovement): BankMovement {
  const amount = mov.group === "pagos" ? Math.abs(mov.amount) : -Math.abs(mov.amount);
  return {
    date: normalizeDate(mov.date),
    description: mov.description.trim(),
    amount,
    balance: 0,
    source: MOVEMENT_SOURCE.credit_card_billed,
    owner: normalizeOwner(mov.owner),
    installments: normalizeInstallments(mov.installments),
  };
}

// ─── Fetch account movements ─────────────────────────────────────

async function fetchAccountMovements(jar: CookieJar, debugLog: string[]): Promise<{ movements: BankMovement[]; balance?: number }> {
  const movements: BankMovement[] = [];
  let balance: number | undefined;

  // Try to get account products
  const productEndpoints = [
    "products",
    "accounts",
    "v1/accounts",
    "cuentas",
    "productos",
    "v1/productos",
  ];

  const productsResult = await tryEndpoints<ApiAccountProduct[] | { accounts: ApiAccountProduct[]; productos: ApiAccountProduct[] }>(
    jar, productEndpoints, "GET", undefined, debugLog,
  );

  if (!productsResult) {
    debugLog.push("   No account products found");
    return { movements, balance };
  }

  const rawProducts = productsResult.data;
  const accounts: ApiAccountProduct[] = Array.isArray(rawProducts)
    ? rawProducts
    : (rawProducts as { accounts?: ApiAccountProduct[] }).accounts ?? (rawProducts as { productos?: ApiAccountProduct[] }).productos ?? [];

  debugLog.push(`   Found ${accounts.length} account(s)`);

  if (accounts.length > 0 && accounts[0].balance !== undefined) {
    balance = accounts[0].balance;
  }

  // Fetch movements for each account
  const movementEndpoints = [
    "movements",
    "accounts/{id}/movements",
    "v1/accounts/{id}/movements",
    "cuentas/{id}/movimientos",
    "movimientos",
    "cartola",
  ];

  for (const account of accounts) {
    const endpointsForAccount = movementEndpoints.map(ep => ep.replace("{id}", account.id || account.number));
    debugLog.push(`   Fetching movements for account ${account.number || account.id}`);

    const result = await tryEndpoints<ApiAccountMovement[] | { movements: ApiAccountMovement[]; movimientos: ApiAccountMovement[] }>(
      jar, endpointsForAccount, "GET", undefined, debugLog,
    );

    if (result) {
      const rawMovs = result.data;
      const movs: ApiAccountMovement[] = Array.isArray(rawMovs)
        ? rawMovs
        : (rawMovs as { movements?: ApiAccountMovement[] }).movements ?? (rawMovs as { movimientos?: ApiAccountMovement[] }).movimientos ?? [];

      for (const mov of movs) {
        movements.push(toAccountMovement(mov));
      }

      // Update balance from first movement if not set
      if (balance === undefined && movs.length > 0 && movs[0].balance !== undefined) {
        balance = movs[0].balance;
      }
    }
  }

  return { movements, balance };
}

// ─── Fetch credit card data ──────────────────────────────────────

async function fetchCreditCardData(
  jar: CookieJar,
  owner: "T" | "A" | "B",
  debugLog: string[],
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  // Try to get credit cards
  const cardEndpoints = [
    "credit-cards",
    "tarjetas",
    "v1/credit-cards",
    "tarjetas-credito",
    "cmr/cards",
    "cards",
  ];

  const cardsResult = await tryEndpoints<ApiCreditCard[] | { cards: ApiCreditCard[]; tarjetas: ApiCreditCard[] }>(
    jar, cardEndpoints, "GET", undefined, debugLog,
  );

  if (!cardsResult) {
    debugLog.push("   No credit cards found");
    return { movements, creditCards };
  }

  const rawCards = cardsResult.data;
  const cards: ApiCreditCard[] = Array.isArray(rawCards)
    ? rawCards
    : (rawCards as { cards?: ApiCreditCard[] }).cards ?? (rawCards as { tarjetas?: ApiCreditCard[] }).tarjetas ?? [];

  debugLog.push(`   Found ${cards.length} credit card(s)`);

  for (const card of cards) {
    const cardLabel = `${card.brand || "CMR"} ${card.type || ""} ****${(card.number || "").slice(-4)}`.trim();
    const cardBody: Record<string, string> = { cardId: card.id, cardNumber: card.number };

    // Owner filter
    if (owner !== "B") {
      cardBody.ownership = owner;
      cardBody.owner = owner;
    }

    // Fetch card balance (cupos)
    const balanceEndpoints = [
      "credit-cards/balance",
      "tarjetas/saldo",
      `credit-cards/${card.id}/balance`,
      `tarjetas/${card.id}/saldo`,
      "cmr/balance",
      "cupos",
    ];

    const balanceResult = await tryEndpoints<ApiCardBalance | Record<string, number>>(
      jar, balanceEndpoints, "POST", cardBody, debugLog,
    );

    if (balanceResult) {
      const b = balanceResult.data as ApiCardBalance;
      const ccEntry: CreditCardBalance = {
        label: cardLabel,
        national: {
          total: b.totalNational ?? 0,
          used: b.usedNational ?? 0,
          available: b.availableNational ?? 0,
        },
      };
      if (b.totalInternational !== undefined) {
        ccEntry.international = {
          total: b.totalInternational,
          used: b.usedInternational ?? 0,
          available: b.availableInternational ?? 0,
          currency: "USD",
        };
      }
      creditCards.push(ccEntry);
    } else {
      creditCards.push({ label: cardLabel });
    }

    // Fetch unbilled movements (movimientos no facturados / ultimos movimientos)
    const unbilledEndpoints = [
      "credit-cards/unbilled",
      "tarjetas/no-facturados",
      `credit-cards/${card.id}/unbilled`,
      `tarjetas/${card.id}/movimientos-no-facturados`,
      "cmr/unbilled-movements",
      "movimientos-no-facturados",
    ];

    const unbilledResult = await tryEndpoints<ApiUnbilledMovement[] | { movements: ApiUnbilledMovement[] }>(
      jar, unbilledEndpoints, "POST", cardBody, debugLog,
    );

    if (unbilledResult) {
      const rawUnbilled = unbilledResult.data;
      const unbilledMovs: ApiUnbilledMovement[] = Array.isArray(rawUnbilled)
        ? rawUnbilled
        : (rawUnbilled as { movements: ApiUnbilledMovement[] }).movements ?? [];

      for (const mov of unbilledMovs) {
        movements.push(toUnbilledMovement(mov));
      }
    }

    // Fetch billed movements (movimientos facturados)
    const billedEndpoints = [
      "credit-cards/billed",
      "tarjetas/facturados",
      `credit-cards/${card.id}/billed`,
      `tarjetas/${card.id}/movimientos-facturados`,
      "cmr/billed-movements",
      "movimientos-facturados",
    ];

    const billedResult = await tryEndpoints<ApiBilledMovement[] | { movements: ApiBilledMovement[] }>(
      jar, billedEndpoints, "POST", cardBody, debugLog,
    );

    if (billedResult) {
      const rawBilled = billedResult.data;
      const billedMovs: ApiBilledMovement[] = Array.isArray(rawBilled)
        ? rawBilled
        : (rawBilled as { movements: ApiBilledMovement[] }).movements ?? [];

      for (const mov of billedMovs) {
        if (mov.group === "totales") continue;
        movements.push(toBilledMovement(mov));
      }
    }
  }

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeFalabella(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, owner = "B", onProgress, onTwoFactorCode } = options;
  const bank = "falabella";
  const progress = onProgress || (() => {});

  // Login
  progress("Conectando con Banco Falabella API...");
  const loginResult = await falabellaLogin(rut, password, debugLog, onTwoFactorCode);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar } = loginResult;
  progress("Sesion iniciada correctamente");

  // Fetch account movements
  debugLog.push("5. Fetching account movements via API...");
  progress("Obteniendo movimientos de cuenta...");
  const acctResult = await fetchAccountMovements(jar, debugLog);
  const balance = acctResult.balance;
  debugLog.push(`   Account movements: ${acctResult.movements.length}`);

  // Fetch credit card data (CMR)
  debugLog.push("6. Fetching CMR credit card data via API...");
  progress("Obteniendo datos de tarjeta CMR...");
  const ccResult = await fetchCreditCardData(jar, owner, debugLog);
  debugLog.push(`   CC movements: ${ccResult.movements.length}`);

  // Combine and deduplicate
  const allMovements = deduplicateMovements([...acctResult.movements, ...ccResult.movements]);
  debugLog.push(`7. Total: ${allMovements.length} unique movements`);
  progress(`Listo — ${allMovements.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements: allMovements,
    balance,
    creditCards: ccResult.creditCards.length > 0 ? ccResult.creditCards : undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const falabella: BankScraper = {
  id: "falabella",
  name: "Banco Falabella",
  url: BANK_URL,
  mode: "api",
  scrape: (options) => runApiScraper("falabella", options, scrapeFalabella),
};

export default falabella;
