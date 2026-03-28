import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, deduplicateMovements, delay } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── BICE constants ─────────────────────────────────────────────
//
// Auth: Keycloak OIDC at auth.bice.cl/realms/personas
// Gateway: gw.bice.cl (OAuth agent proxy + BFF endpoints)
//
// Architecture: API-first with browser fallback for login
//   1. Try HTTP login to Keycloak (may be blocked by Cloudflare)
//   2. If blocked, fall back to browser login via remoteCDP or local Chrome
//   3. After login, use pure HTTP calls to gw.bice.cl BFF endpoints
//   4. POST /products to list accounts
//   5. POST /transactions for movements (paginated, 40 per page)
//   6. POST /balance for account balance

const KEYCLOAK_AUTH_URL =
  "https://auth.bice.cl/realms/personas/protocol/openid-connect/auth?" +
  "client_id=portal-personas" +
  "&redirect_uri=https%3A%2F%2Fportalpersonas.bice.cl%2F" +
  "&response_type=code" +
  "&scope=openid+profile";

const GW_BASE = "https://gw.bice.cl";
const OAUTH_AGENT = `${GW_BASE}/oauth-agent-personas`;
const BFF_BASE = `${GW_BASE}/portalpersonas`;
const PORTAL_ORIGIN = "https://portalpersonas.bice.cl";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TRANSACTIONS_PAGE_SIZE = 40;
const MAX_TRANSACTION_PAGES = 25;

// ─── Cookie jar ──────────────────────────────────────────────────

interface CookieJar {
  cookies: Map<string, string>;
  set(raw: string): void;
  setAll(headers: Headers): void;
  header(): string;
  toJSON(): string;
}

function createCookieJar(initial?: Record<string, string>): CookieJar {
  const cookies = new Map<string, string>(
    initial ? Object.entries(initial) : [],
  );
  return {
    cookies,
    set(raw: string) {
      const [nameValue] = raw.split(";");
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx > 0)
        cookies.set(
          nameValue.slice(0, eqIdx).trim(),
          nameValue.slice(eqIdx + 1).trim(),
        );
    },
    setAll(headers: Headers) {
      const setCookies = headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) this.set(raw);
    },
    header() {
      return Array.from(cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
    toJSON() {
      return JSON.stringify(Object.fromEntries(cookies));
    },
  };
}

// ─── API types ───────────────────────────────────────────────────

interface BiceTransaction {
  fecha?: string;
  fechaSinFormato?: string;
  fechacontable?: string;
  descripcion?: string;
  narrativa?: string;
  monto?: string;
  tipo?: string;
  codtrn?: string;
  [key: string]: unknown;
}

interface BiceTransactionsResponse {
  movimientos?: BiceTransaction[];
  paginacion?: {
    paginaActual?: number;
    totalPaginas?: number;
    totalRegistros?: number;
    tamanioPagina?: number;
  };
  [key: string]: unknown;
}

interface BiceBalanceResponse {
  titulo?: string;
  monto?: string;
  saldoDisponibleMonto?: string;
  saldoDisponibleDescripcion?: string;
  saldoContableDescripcion?: string;
  [key: string]: unknown;
}

interface BiceProductsResponse {
  productos?: Array<{
    tipo?: string;
    numero?: string;
    nombre?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// ─── Transaction parsing ─────────────────────────────────────────

function parseTransaction(tx: BiceTransaction): BankMovement | null {
  // Date: prefer fechaSinFormato "20260326" -> "26-03-2026", fallback to fecha "26 mar 2026"
  let dateStr = "";
  if (tx.fechaSinFormato && /^\d{8}$/.test(tx.fechaSinFormato)) {
    const y = tx.fechaSinFormato.slice(0, 4);
    const m = tx.fechaSinFormato.slice(4, 6);
    const d = tx.fechaSinFormato.slice(6, 8);
    dateStr = `${d}-${m}-${y}`;
  } else if (tx.fecha) {
    dateStr = normalizeDate(tx.fecha);
  }
  if (!dateStr) return null;

  // Description: prefer narrativa (full), fallback to descripcion
  const description = (tx.narrativa || tx.descripcion || "").trim();
  if (!description) return null;

  // Amount: monto is a string without dots/commas (e.g. "2003")
  const rawAmount = parseInt(tx.monto || "0", 10);
  if (!rawAmount) return null;

  // tipo: "cargo" = negative (expense), "abono" = positive (income)
  const tipo = (tx.tipo || "").toLowerCase();
  const amount = tipo === "cargo" ? -Math.abs(rawAmount) : Math.abs(rawAmount);

  return {
    date: dateStr,
    description,
    amount,
    balance: 0, // BICE transactions API does not include running balance per movement
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────

/** Build common headers for gw.bice.cl requests */
function gwHeaders(jar: CookieJar): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "application/json",
    "Content-Type": "application/json",
    Cookie: jar.header(),
    Origin: PORTAL_ORIGIN,
    Referer: `${PORTAL_ORIGIN}/`,
  };
}

/** POST to a BFF endpoint on gw.bice.cl */
async function bffPost<T>(
  jar: CookieJar,
  path: string,
  body: unknown = {},
  debugLog: string[],
): Promise<T> {
  const url = `${BFF_BASE}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: gwHeaders(jar),
    body: JSON.stringify(body),
    redirect: "follow",
  });
  jar.setAll(res.headers);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    debugLog.push(`  BFF POST ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`BFF POST ${path} -> ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ─── Keycloak HTTP login ─────────────────────────────────────────
//
// Attempts a pure HTTP login to Keycloak. This may fail if Cloudflare
// is actively challenging requests (403 with cf-mitigated header).
// In that case, the caller falls back to browser-based login.

async function keycloakHttpLogin(
  rut: string,
  password: string,
  debugLog: string[],
): Promise<
  | { success: true; jar: CookieJar }
  | { success: false; error: string; cloudflareBlocked?: boolean }
> {
  const jar = createCookieJar();
  const formattedRut = formatRut(rut);

  // Step 1: GET the Keycloak auth URL to get the login form
  debugLog.push("1. Fetching Keycloak login page via HTTP...");
  const authRes = await fetch(KEYCLOAK_AUTH_URL, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  jar.setAll(authRes.headers);

  // Check for Cloudflare challenge
  const cfMitigated = authRes.headers.get("cf-mitigated");
  if (cfMitigated === "challenge" || authRes.status === 403) {
    debugLog.push(`  Cloudflare challenge detected (status=${authRes.status}, cf-mitigated=${cfMitigated})`);
    return { success: false, error: "Cloudflare challenge", cloudflareBlocked: true };
  }

  if (!authRes.ok) {
    debugLog.push(`  Keycloak page returned ${authRes.status}`);
    return { success: false, error: `Keycloak page returned ${authRes.status}` };
  }

  const html = await authRes.text();
  debugLog.push(`  Status: ${authRes.status}, HTML length: ${html.length}`);

  // Step 2: Parse the Keycloak form action URL and hidden fields
  // Keycloak renders a standard HTML form with action URL containing session codes
  const actionMatch = html.match(/action="([^"]+)"/);
  if (!actionMatch) {
    // Check if this is a Cloudflare challenge page disguised as 200
    if (html.includes("cf-challenge") || html.includes("turnstile") || html.includes("ray ID")) {
      debugLog.push("  Cloudflare challenge page (no form action found)");
      return { success: false, error: "Cloudflare challenge page", cloudflareBlocked: true };
    }
    debugLog.push("  No form action found in Keycloak HTML");
    return { success: false, error: "No form action found in Keycloak page" };
  }

  // Keycloak HTML-encodes the action URL (e.g. &amp; -> &)
  const formAction = actionMatch[1].replace(/&amp;/g, "&");
  debugLog.push(`  Form action: ${formAction.slice(0, 80)}...`);

  // Step 3: POST credentials to the Keycloak form
  debugLog.push("2. Submitting credentials to Keycloak...");
  const formBody = new URLSearchParams({
    username: formattedRut,
    password: password,
  });

  const loginRes = await fetch(formAction, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
      Referer: authRes.url,
    },
    body: formBody.toString(),
    redirect: "manual", // We need to follow redirects manually to capture cookies
  });
  jar.setAll(loginRes.headers);

  debugLog.push(`  Login response: ${loginRes.status}`);

  // Check for login error (Keycloak returns 200 with error message on bad credentials)
  if (loginRes.status === 200) {
    const errorHtml = await loginRes.text();
    if (
      errorHtml.includes("kc-feedback-text") ||
      errorHtml.includes("Invalid username or password") ||
      errorHtml.includes("invalid_grant") ||
      errorHtml.includes("credenciales")
    ) {
      return { success: false, error: "Credenciales incorrectas (RUT o clave invalida)." };
    }
    // Check for 2FA page
    if (
      errorHtml.includes("otp") ||
      errorHtml.includes("two-factor") ||
      errorHtml.includes("segundo factor") ||
      errorHtml.includes("kc-form-otp")
    ) {
      return { success: false, error: "Se requiere 2FA. Use modo browser para autenticacion con 2FA." };
    }
    debugLog.push("  Unexpected 200 response after login POST");
    return { success: false, error: "Respuesta inesperada del servidor de autenticacion." };
  }

  // Step 4: Follow the redirect chain (Keycloak -> portal with ?code=xxx)
  // Keycloak returns 302 -> portalpersonas.bice.cl/?code=xxx&session_state=xxx
  if (loginRes.status !== 302 && loginRes.status !== 303) {
    debugLog.push(`  Unexpected status: ${loginRes.status}`);
    return { success: false, error: `Keycloak returned unexpected status ${loginRes.status}` };
  }

  let location = loginRes.headers.get("location") || "";
  debugLog.push(`  Redirect to: ${location.slice(0, 100)}...`);

  // Follow redirects manually to collect all cookies
  let redirectCount = 0;
  while (location && redirectCount < 10) {
    redirectCount++;
    const redirectRes = await fetch(location, {
      headers: {
        "User-Agent": UA,
        Cookie: jar.header(),
      },
      redirect: "manual",
    });
    jar.setAll(redirectRes.headers);

    const nextLocation = redirectRes.headers.get("location") || "";
    debugLog.push(`  Redirect ${redirectCount}: ${redirectRes.status} -> ${nextLocation.slice(0, 80)}`);

    if (!nextLocation || redirectRes.status < 300 || redirectRes.status >= 400) {
      // We've reached the final destination or a non-redirect response
      break;
    }
    location = nextLocation;
  }

  // Step 5: Extract the auth code from the final redirect URL
  // The portal redirect URL contains ?code=xxx which we need for oauth-agent
  const codeMatch = location.match(/[?&]code=([^&]+)/);
  if (!codeMatch) {
    // Try to find it in the redirect chain we already followed
    debugLog.push("  No auth code found in redirect chain, checking jar...");
    // The oauth-agent might have already set session cookies during the redirect
    // Check if we have session cookies from gw.bice.cl
    const hasSessionCookie = [...jar.cookies.keys()].some(
      (k) => k.includes("AT") || k.includes("RT") || k.includes("session"),
    );
    if (hasSessionCookie) {
      debugLog.push("  Found session cookies (oauth-agent may have already processed the code)");
      debugLog.push(`3. Login OK via HTTP! Cookies: ${[...jar.cookies.keys()].join(", ")}`);
      return { success: true, jar };
    }
    debugLog.push("  No auth code and no session cookies found");
    return { success: false, error: "No se obtuvo codigo de autorizacion de Keycloak." };
  }

  const authCode = codeMatch[1];
  debugLog.push(`  Auth code obtained: ${authCode.slice(0, 10)}...`);

  // Step 6: Exchange the code via the OAuth agent
  // POST /oauth-agent-personas/login/start initiates the session
  debugLog.push("3. Calling oauth-agent login/start...");
  const startRes = await fetch(`${OAUTH_AGENT}/login/start`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Origin: PORTAL_ORIGIN,
      Referer: `${PORTAL_ORIGIN}/`,
    },
    body: JSON.stringify({
      pageUrl: `${PORTAL_ORIGIN}/?code=${authCode}`,
    }),
    redirect: "follow",
  });
  jar.setAll(startRes.headers);
  debugLog.push(`  login/start: ${startRes.status}`);

  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => "");
    debugLog.push(`  login/start error: ${errText.slice(0, 200)}`);
    return { success: false, error: `oauth-agent login/start failed: ${startRes.status}` };
  }

  // Step 7: Complete the session
  // POST /oauth-agent-personas/login/end sets HTTP-only session cookies
  debugLog.push("4. Calling oauth-agent login/end...");
  const endRes = await fetch(`${OAUTH_AGENT}/login/end`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Origin: PORTAL_ORIGIN,
      Referer: `${PORTAL_ORIGIN}/`,
    },
    body: JSON.stringify({}),
    redirect: "follow",
  });
  jar.setAll(endRes.headers);
  debugLog.push(`  login/end: ${endRes.status}`);

  if (!endRes.ok) {
    const errText = await endRes.text().catch(() => "");
    debugLog.push(`  login/end error: ${errText.slice(0, 200)}`);
    return { success: false, error: `oauth-agent login/end failed: ${endRes.status}` };
  }

  // Step 8: Verify session by calling userInfo
  debugLog.push("5. Verifying session via userInfo...");
  const userInfoRes = await fetch(`${OAUTH_AGENT}/userInfo`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: jar.header(),
      Origin: PORTAL_ORIGIN,
      Referer: `${PORTAL_ORIGIN}/`,
    },
  });
  jar.setAll(userInfoRes.headers);

  if (userInfoRes.ok) {
    const userInfo = (await userInfoRes.json()) as Record<string, unknown>;
    debugLog.push(`  userInfo: ${JSON.stringify(userInfo).slice(0, 200)}`);
  } else {
    debugLog.push(`  userInfo: ${userInfoRes.status} (non-fatal)`);
  }

  debugLog.push(`6. Login OK via HTTP! Cookies: ${[...jar.cookies.keys()].join(", ")}`);
  return { success: true, jar };
}

// ─── Browser fallback login ──────────────────────────────────────
//
// When Cloudflare blocks the HTTP login, we use a browser to get through
// the challenge, then extract the session cookies for pure HTTP data calls.

async function browserFallbackLogin(
  options: ScraperOptions,
  debugLog: string[],
): Promise<
  | { success: true; jar: CookieJar }
  | { success: false; error: string }
> {
  debugLog.push("--- Browser fallback login (Cloudflare blocked HTTP) ---");

  // Dynamically import browser infrastructure (avoid top-level heavy import)
  const { launchBrowser } = await import("../infrastructure/browser.js");

  const { rut, password, chromePath, headful, launchArgs, userDataDir, remoteCDP, onProgress, onTwoFactorCode } = options;
  const progress = onProgress || (() => {});
  const formattedRut = formatRut(rut);

  progress("Usando navegador para autenticacion (Cloudflare)...");

  const session = await launchBrowser(
    { chromePath, headful, launchArgs, userDataDir, remoteCDP },
    !!options.saveScreenshots,
  );

  try {
    const { page } = session;

    // Navigate to Keycloak directly
    debugLog.push("B1. Navigating to Keycloak...");
    await page.goto(KEYCLOAK_AUTH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await delay(1000);

    // Wait for the login form
    debugLog.push("B2. Waiting for #username field...");
    const usernameField = await page.waitForSelector("#username", { timeout: 30_000 }).catch(() => null);
    if (!usernameField) {
      // Try to wait longer (Cloudflare challenge may take time)
      const start = Date.now();
      let found = false;
      while (Date.now() - start < 30_000) {
        const el = await page.$("#username");
        if (el) { found = true; break; }
        await delay(2000);
      }
      if (!found) {
        return { success: false, error: "No se encontro el campo de login en Keycloak (navegador)." };
      }
    }

    // Fill credentials
    debugLog.push("B3. Entering credentials...");
    progress("Ingresando credenciales...");
    await page.type("#username", formattedRut, { delay: 60 });
    await delay(300);

    await page.waitForSelector("#password", { timeout: 5_000 });
    await page.type("#password", password, { delay: 60 });
    await delay(300);

    // Submit
    debugLog.push("B4. Submitting login...");
    progress("Autenticando...");
    const kcLoginBtn = await page.$("#kc-login");
    if (kcLoginBtn) {
      await kcLoginBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    // Wait for navigation
    try {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      await delay(5000);
    }

    const postLoginUrl = page.url();
    debugLog.push(`  Post-login URL: ${postLoginUrl}`);

    // Check for 2FA
    if (postLoginUrl.includes("auth.bice.cl")) {
      const pageHtml = await page.content();
      const pageLower = pageHtml.toLowerCase();
      const twoFactorKeywords = ["otp", "two-factor", "segundo factor", "verificaci", "authenticator", "kc-form-otp"];

      if (twoFactorKeywords.some((kw) => pageLower.includes(kw))) {
        debugLog.push("  2FA detected");
        progress("Esperando codigo de verificacion...");

        if (!onTwoFactorCode) {
          return { success: false, error: "Se requiere codigo 2FA pero no hay callback configurado." };
        }

        const code = await onTwoFactorCode();
        if (!code) {
          return { success: false, error: "No se recibio codigo 2FA." };
        }

        const otpInput =
          (await page.$("#otp")) ||
          (await page.$("input[name='otp']")) ||
          (await page.$("input[name='totp']"));
        if (otpInput) {
          await otpInput.fill(code);
        } else {
          const inputs = await page.$$("input[type='text'], input[type='number'], input:not([type])");
          if (inputs.length > 0) await inputs[0].type(code, { delay: 60 });
        }

        const submitBtn = (await page.$("#kc-login")) || (await page.$("input[type='submit']"));
        if (submitBtn) await submitBtn.click();

        try {
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
        } catch {
          await delay(5000);
        }

        if (page.url().includes("auth.bice.cl")) {
          return { success: false, error: "Codigo 2FA incorrecto o expirado." };
        }
      } else {
        // Login error
        const errorEl = await page.$(".kc-feedback-text, [class*='alert'], [class*='error']");
        const errorText = errorEl ? await errorEl.innerText().catch(() => null) : null;
        return { success: false, error: `Credenciales incorrectas: ${errorText || "RUT o clave invalida."}` };
      }
    }

    // Wait for portal to load and oauth-agent to set cookies
    debugLog.push("B5. Waiting for portal to complete OAuth agent flow...");
    progress("Completando autenticacion...");
    await delay(3000);

    // Extract cookies from the browser context
    // The oauth-agent sets HTTP-only cookies on gw.bice.cl during the redirect
    const browserCookies = await session.context.cookies(["https://gw.bice.cl", "https://portalpersonas.bice.cl"]);
    debugLog.push(`  Browser cookies: ${browserCookies.map((c) => c.name).join(", ")}`);

    const jar = createCookieJar();
    for (const cookie of browserCookies) {
      jar.cookies.set(cookie.name, cookie.value);
    }

    if (jar.cookies.size === 0) {
      return { success: false, error: "No se obtuvieron cookies de sesion del navegador." };
    }

    debugLog.push(`B6. Browser login OK! Cookies: ${[...jar.cookies.keys()].join(", ")}`);
    return { success: true, jar };
  } finally {
    // Always close the browser — we only need the cookies
    await session.browser.close().catch(() => {});
  }
}

// ─── Data fetching ───────────────────────────────────────────────

async function fetchProducts(
  jar: CookieJar,
  debugLog: string[],
): Promise<BiceProductsResponse> {
  debugLog.push("  Fetching products...");
  return bffPost<BiceProductsResponse>(
    jar,
    "bff-portal-hbp/v1/products",
    {},
    debugLog,
  );
}

async function fetchBalance(
  jar: CookieJar,
  debugLog: string[],
): Promise<number | undefined> {
  debugLog.push("  Fetching balance...");
  try {
    const balanceData = await bffPost<BiceBalanceResponse>(
      jar,
      "bff-checking-account-transactions-100/v1/balance",
      {},
      debugLog,
    );
    const rawBalance = balanceData?.saldoDisponibleMonto || balanceData?.monto;
    if (rawBalance) {
      const balance = parseInt(rawBalance, 10);
      debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
      return balance;
    }
    debugLog.push(`  Balance response but no monto: ${JSON.stringify(balanceData).slice(0, 200)}`);
  } catch (err) {
    debugLog.push(`  Balance fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

async function fetchTransactions(
  jar: CookieJar,
  debugLog: string[],
): Promise<BankMovement[]> {
  const movements: BankMovement[] = [];

  debugLog.push("  Fetching transactions (paginated)...");

  for (let pageNum = 1; pageNum <= MAX_TRANSACTION_PAGES; pageNum++) {
    try {
      const txData = await bffPost<BiceTransactionsResponse>(
        jar,
        "bff-checking-account-transactions-100/v1/transactions",
        { pagina: pageNum, tamanioPagina: TRANSACTIONS_PAGE_SIZE },
        debugLog,
      );

      const rawMovimientos = txData?.movimientos || [];
      debugLog.push(`  Page ${pageNum}: ${rawMovimientos.length} raw transactions`);

      if (rawMovimientos.length === 0) break;

      for (const tx of rawMovimientos) {
        const mov = parseTransaction(tx);
        if (mov) movements.push(mov);
      }

      // Check if there are more pages
      const pagination = txData?.paginacion;
      if (pagination) {
        const totalPages = pagination.totalPaginas || 1;
        if (pageNum >= totalPages) break;
      } else {
        // No pagination info — if we got fewer than page size, assume last page
        if (rawMovimientos.length < TRANSACTIONS_PAGE_SIZE) break;
      }
    } catch (err) {
      debugLog.push(`  Page ${pageNum} error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return movements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBice(
  options: ScraperOptions,
  debugLog: string[],
): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const bank = "bice";
  const progress = onProgress || (() => {});

  // 1. Login
  progress("Conectando con BICE API...");

  // Try HTTP login first (fast, no browser needed)
  let loginResult = await keycloakHttpLogin(rut, password, debugLog);

  // If Cloudflare blocked the HTTP login, fall back to browser
  if (!loginResult.success && "cloudflareBlocked" in loginResult && loginResult.cloudflareBlocked) {
    debugLog.push("--- Cloudflare blocked HTTP login, falling back to browser ---");
    progress("Cloudflare detectado, usando navegador...");

    // Check if we have a way to use a browser
    if (!options.remoteCDP && !options.chromePath && !options.headful) {
      // Try to import findChrome to check if Chrome is available
      const { findChrome } = await import("../utils.js");
      const chromePath = findChrome();
      if (!chromePath) {
        return {
          success: false,
          bank,
          movements: [],
          error:
            "Cloudflare bloquea el acceso HTTP a BICE. " +
            "Se necesita un navegador para la autenticacion, pero no se encontro Chrome. " +
            "Instala Chrome o configura remoteCDP.",
          debug: debugLog.join("\n"),
        };
      }
    }

    loginResult = await browserFallbackLogin(options, debugLog);
  }

  if (!loginResult.success) {
    return {
      success: false,
      bank,
      movements: [],
      error: loginResult.error,
      debug: debugLog.join("\n"),
    };
  }

  const { jar } = loginResult;
  progress("Sesion iniciada correctamente");

  // 2. Fetch products (to identify accounts)
  debugLog.push("7. Fetching products and data via API...");
  progress("Obteniendo productos...");
  try {
    const products = await fetchProducts(jar, debugLog);
    debugLog.push(`  Products: ${JSON.stringify(products).slice(0, 300)}`);
  } catch (err) {
    debugLog.push(`  Products fetch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Fetch balance and transactions in parallel
  debugLog.push("8. Fetching balance and transactions...");
  progress("Extrayendo movimientos...");

  const [balance, movements] = await Promise.all([
    fetchBalance(jar, debugLog),
    fetchTransactions(jar, debugLog),
  ]);

  debugLog.push(`  Balance: ${balance !== undefined ? `$${balance.toLocaleString("es-CL")}` : "N/A"}`);
  debugLog.push(`  Raw movements: ${movements.length}`);

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`9. Total: ${deduplicated.length} unique movements`);
  progress(`Listo - ${deduplicated.length} movimientos totales`);

  // Persist cookies for session reuse
  const sessionCookies = jar.toJSON();

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance,
    sessionCookies,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const bice: BankScraper = {
  id: "bice",
  name: "Banco BICE",
  url: PORTAL_ORIGIN,
  mode: "api",
  scrape: (options) => runApiScraper("bice", options, scrapeBice, 60_000),
};

export default bice;
