import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, deduplicateMovements, delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── BICE constants ─────────────────────────────────────────────
//
// Auth: Keycloak OIDC at auth.bice.cl/realms/personas
// Gateway: gw.bice.cl (OAuth agent proxy + BFF endpoints)
//
// Architecture: Hybrid browser + API
//   1. Browser login (Puppeteer) — navigate to portal, fill Keycloak form
//   2. After login, browser has session cookies for gw.bice.cl
//   3. Use page.evaluate(fetch(...)) to call BFF endpoints — cookies included automatically
//
// The portal at portalpersonas.bice.cl returns 403 to Node.js fetch()
// (Cloudflare WAF). Keycloak login cannot complete without a browser.
// However, once logged in, the gw.bice.cl BFF endpoints work via
// page.evaluate(fetch(...)) with the browser's cookies.

const PORTAL_URL = "https://portalpersonas.bice.cl";
const GW_BASE = "https://gw.bice.cl";
const BFF_PRODUCTS = `${GW_BASE}/portalpersonas/bff-portal-hbp/v1/products`;
const BFF_BALANCE = `${GW_BASE}/portalpersonas/bff-checking-account-transactions-100/v1/balance`;
const BFF_TRANSACTIONS = `${GW_BASE}/portalpersonas/bff-checking-account-transactions-100/v1/transactions`;

const TWO_FACTOR_KEYWORDS = ["otp", "two-factor", "segundo factor", "verificaci", "authenticator", "kc-form-otp"];

// ─── Login via browser (Keycloak) ────────────────────────────────

async function biceLogin(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<{ success: true } | { success: false; error: string }> {
  const { page, debugLog, screenshot: doSave } = session;
  const { rut, password, onProgress, onTwoFactorCode } = options;
  const progress = onProgress || (() => {});

  // Step 1: Navigate to portal — triggers Keycloak redirect
  debugLog.push("1. Navigating to portal (triggers Keycloak redirect)...");
  progress("Abriendo portal BICE...");
  await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 45_000 });
  await delay(2000);
  await doSave(page, "bice-01-after-navigate");

  const landingUrl = page.url();
  debugLog.push(`  Landed on: ${landingUrl}`);

  // Check if we're on Keycloak (auth.bice.cl)
  if (!landingUrl.includes("auth.bice.cl")) {
    // The portal might not have redirected yet — try waiting
    debugLog.push("  Not on Keycloak yet, waiting for redirect...");
    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10_000 });
    } catch {
      // May already be there
    }
    const currentUrl = page.url();
    debugLog.push(`  Current URL: ${currentUrl}`);

    if (!currentUrl.includes("auth.bice.cl")) {
      // Check if there's a login button we need to click
      const pageText = await page.evaluate(() => document.body?.innerText || "");
      if (pageText.toLowerCase().includes("403") || pageText.toLowerCase().includes("forbidden")) {
        return {
          success: false,
          error: "Portal BICE bloqueo el acceso (403 Forbidden). Usa --headful --profile.",
        };
      }
      return {
        success: false,
        error: `No se redirigió a Keycloak (auth.bice.cl). URL actual: ${currentUrl}`,
      };
    }
  }

  await doSave(page, "bice-02-keycloak-page");
  debugLog.push("2. On Keycloak login page");

  // Step 2: Fill Keycloak login form
  debugLog.push("3. Entering credentials...");
  progress("Ingresando credenciales...");

  // Wait for the username field
  try {
    await page.waitForSelector("#username", { timeout: 15_000 });
  } catch {
    // Fallback: try looking for input by name or type
    const hasInput = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input[type='text'], input[name='username']");
      return inputs.length > 0;
    });
    if (!hasInput) {
      await doSave(page, "bice-03-no-username-field");
      return {
        success: false,
        error: "No se encontro el campo de RUT (#username) en la pagina de Keycloak.",
      };
    }
  }

  // BICE Keycloak expects formatted RUT with dots (e.g. "17.599.449-1")
  const formattedRut = formatRut(rut);
  debugLog.push(`  Typing RUT: ${formattedRut.slice(0, 6)}...`);
  await page.type("#username", formattedRut, { delay: 60 });
  await delay(300);

  // Wait for and fill password field
  try {
    await page.waitForSelector("#password", { timeout: 5_000 });
  } catch {
    await doSave(page, "bice-04-no-password-field");
    return {
      success: false,
      error: "No se encontro el campo de clave (#password).",
    };
  }

  await page.type("#password", password, { delay: 60 });
  await delay(300);
  await doSave(page, "bice-05-credentials-filled");

  // Step 3: Click the login button
  debugLog.push("4. Clicking login button...");
  progress("Autenticando...");

  const loginClicked = await page.evaluate(() => {
    // Primary: #kc-login (standard Keycloak submit)
    const kcLogin = document.querySelector("#kc-login") as HTMLElement | null;
    if (kcLogin) {
      kcLogin.click();
      return "kc-login";
    }
    // Fallback: button "Ingresar" or submit button
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
    for (const btn of buttons) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      const value = (btn as HTMLInputElement).value?.toLowerCase() || "";
      if (text.includes("ingresar") || value.includes("ingresar") || text.includes("login") || value.includes("login")) {
        (btn as HTMLElement).click();
        return "fallback-btn";
      }
    }
    return null;
  });

  if (!loginClicked) {
    // Last resort: press Enter
    await page.keyboard.press("Enter");
    debugLog.push("  Pressed Enter (no login button found)");
  } else {
    debugLog.push(`  Clicked: ${loginClicked}`);
  }

  // Step 4: Wait for response (redirect back to portal, error, or 2FA)
  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 });
  } catch {
    // Navigation might already have completed or be slow
    await delay(5000);
  }
  await doSave(page, "bice-06-after-login-submit");

  const postLoginUrl = page.url();
  debugLog.push(`  Post-login URL: ${postLoginUrl}`);

  // Still on Keycloak? Check for errors or 2FA
  if (postLoginUrl.includes("auth.bice.cl")) {
    const pageHtml = await page.evaluate(() => document.documentElement.outerHTML);
    const pageLower = pageHtml.toLowerCase();

    // Check for 2FA
    if (TWO_FACTOR_KEYWORDS.some(kw => pageLower.includes(kw))) {
      debugLog.push("  2FA detected on Keycloak page");
      progress("Esperando codigo de verificacion...");
      await doSave(page, "bice-07-2fa-detected");

      if (!onTwoFactorCode) {
        return {
          success: false,
          error: "Se requiere codigo 2FA pero no hay callback configurado.",
        };
      }

      const code = await onTwoFactorCode();
      if (!code) {
        return { success: false, error: "No se recibio codigo 2FA." };
      }

      debugLog.push("  Submitting 2FA code...");

      // Try typing into OTP field
      const otpTyped = await page.evaluate((c: string) => {
        const otpInput = document.querySelector("#otp") as HTMLInputElement
          || document.querySelector("input[name='otp']") as HTMLInputElement
          || document.querySelector("input[name='totp']") as HTMLInputElement;
        if (otpInput) {
          otpInput.value = c;
          otpInput.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        return false;
      }, code);

      if (!otpTyped) {
        // Fallback: type into the first visible text input
        const inputs = await page.$$("input[type='text'], input[type='number'], input:not([type])");
        if (inputs.length > 0) {
          await inputs[0].type(code, { delay: 60 });
        }
      }

      // Click submit button
      await page.evaluate(() => {
        const kcLogin = document.querySelector("#kc-login") as HTMLElement
          || document.querySelector("input[type='submit']") as HTMLElement;
        if (kcLogin) kcLogin.click();
      });

      try {
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 });
      } catch {
        await delay(5000);
      }

      const post2faUrl = page.url();
      debugLog.push(`  Post-2FA URL: ${post2faUrl}`);

      if (post2faUrl.includes("auth.bice.cl")) {
        const errorText = await page.evaluate(() => {
          const el = document.querySelector(".kc-feedback-text, [class*='alert'], [class*='error']");
          return el ? (el as HTMLElement).innerText?.trim() : null;
        });
        return {
          success: false,
          error: `Error 2FA: ${errorText || "Codigo incorrecto o expirado."}`,
        };
      }
    } else {
      // Check for login errors (still on Keycloak but not 2FA)
      const errorText = await page.evaluate(() => {
        const el = document.querySelector(".kc-feedback-text, [class*='alert'], [class*='error']");
        return el ? (el as HTMLElement).innerText?.trim() : null;
      });
      if (errorText) {
        return {
          success: false,
          error: `Credenciales incorrectas: ${errorText}`,
        };
      }
      return {
        success: false,
        error: "Credenciales incorrectas (RUT o clave invalida).",
      };
    }
  }

  // Step 5: Wait for the portal to fully load (Angular SPA)
  // After Keycloak auth, the portal redirects back. The SPA calls
  // login/start + login/end on gw.bice.cl to set up session cookies.
  debugLog.push("5. Waiting for portal to load...");
  progress("Sesion iniciada, cargando portal...");

  // Wait for the portal URL to settle (may go through several redirects)
  const portalLoadStart = Date.now();
  const MAX_PORTAL_WAIT = 30_000;
  let portalLoaded = false;

  while (Date.now() - portalLoadStart < MAX_PORTAL_WAIT) {
    const currentUrl = page.url();
    if (currentUrl.includes("portalpersonas.bice.cl") && !currentUrl.includes("auth.bice.cl")) {
      // Wait for the Angular app to render something meaningful
      const hasContent = await page.evaluate(() => {
        const body = document.body?.innerText || "";
        // The dashboard shows account info, "Resumen", or product names
        return body.includes("Resumen") || body.includes("Cuenta") || body.includes("Saldo") || body.length > 500;
      });
      if (hasContent) {
        portalLoaded = true;
        break;
      }
    }
    await delay(2000);
  }

  if (!portalLoaded) {
    // Check for new tabs — BICE sometimes opens the banking portal in a new tab
    const pages = await session.browser.pages();
    for (const p of pages) {
      const pUrl = p.url();
      if (pUrl.includes("portalpersonas.bice.cl") && pUrl !== page.url()) {
        debugLog.push(`  Found portal in another tab: ${pUrl}`);
        // We'll use page.evaluate on the original page anyway,
        // but let's check if this tab has content
        const hasContent = await p.evaluate(() => {
          const body = document.body?.innerText || "";
          return body.includes("Resumen") || body.includes("Cuenta") || body.length > 500;
        }).catch(() => false);
        if (hasContent) {
          portalLoaded = true;
          break;
        }
      }
    }
  }

  await doSave(page, "bice-08-portal-loaded");

  if (!portalLoaded) {
    const finalUrl = page.url();
    debugLog.push(`  Portal did not fully load. URL: ${finalUrl}`);
    // Continue anyway — the cookies might still be set even if the UI hasn't loaded
    debugLog.push("  Proceeding with API calls regardless...");
  }

  // Give the OAuth agent login/start + login/end calls time to complete
  // These are triggered by the Angular app on load and set the gw.bice.cl cookies
  await delay(3000);

  debugLog.push("6. Login OK!");
  return { success: true };
}

// ─── API response types ──────────────────────────────────────────

interface BiceProduct {
  id?: string;
  accountNumber?: string;
  productType?: string;
  productName?: string;
  currency?: string;
  balance?: number;
  availableBalance?: number;
  [key: string]: unknown;
}

interface BiceProductsResponse {
  products?: BiceProduct[];
  accounts?: BiceProduct[];
  data?: BiceProduct[];
  [key: string]: unknown;
}

interface BiceTransaction {
  date?: string;
  fecha?: string;
  transactionDate?: string;
  description?: string;
  descripcion?: string;
  glosa?: string;
  amount?: number;
  monto?: number;
  cargo?: number;
  abono?: number;
  balance?: number;
  saldo?: number;
  category?: string;
  tipo?: string;
  type?: string;
  [key: string]: unknown;
}

interface BiceTransactionsResponse {
  transactions?: BiceTransaction[];
  movimientos?: BiceTransaction[];
  data?: BiceTransaction[];
  content?: BiceTransaction[];
  totalPages?: number;
  totalElements?: number;
  page?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

// ─── Data extraction ─────────────────────────────────────────────

function biceTransactionToMovement(tx: BiceTransaction): BankMovement | null {
  // Extract date from various possible field names
  const dateStr = tx.date || tx.fecha || tx.transactionDate || "";
  if (!dateStr) return null;

  // Extract description
  const description = (tx.description || tx.descripcion || tx.glosa || "").trim();
  if (!description) return null;

  // Extract amount — BICE uses Cargos (negative) and Abonos (positive)
  let amount: number;
  if (tx.amount !== undefined && tx.amount !== null) {
    amount = tx.amount;
  } else if (tx.monto !== undefined && tx.monto !== null) {
    amount = tx.monto;
  } else if (tx.cargo !== undefined && Number(tx.cargo) > 0) {
    amount = -Math.abs(Number(tx.cargo));
  } else if (tx.abono !== undefined && Number(tx.abono) > 0) {
    amount = Math.abs(Number(tx.abono));
  } else {
    return null;
  }

  // If category/type says "Cargos" and amount is positive, flip to negative
  const category = (tx.category || tx.tipo || tx.type || "").toLowerCase();
  if (category.includes("cargo") && amount > 0) {
    amount = -amount;
  }
  // If category says "Abonos" and amount is negative, flip to positive
  if (category.includes("abono") && amount < 0) {
    amount = -amount;
  }

  const balance = tx.balance ?? tx.saldo ?? 0;

  return {
    date: normalizeDate(dateStr),
    description,
    amount,
    balance: typeof balance === "number" ? balance : 0,
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── BFF data fetching via page.evaluate(fetch(...)) ─────────────

/**
 * Execute a POST to a BFF endpoint using the browser's fetch (includes cookies).
 * Returns the parsed JSON response or null on failure.
 */
async function bffPostViaBrowser<T>(
  session: BrowserSession,
  url: string,
  body: unknown = {},
): Promise<T | null> {
  const { page, debugLog } = session;
  const result = await page.evaluate(
    async (fetchUrl: string, fetchBody: string) => {
      try {
        const res = await fetch(fetchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: fetchBody,
        });
        if (!res.ok) {
          return { __error: true, status: res.status, statusText: res.statusText };
        }
        return await res.json();
      } catch (err) {
        return { __error: true, message: String(err) };
      }
    },
    url,
    JSON.stringify(body),
  );

  if (result && typeof result === "object" && "__error" in result) {
    const errResult = result as { status?: number; statusText?: string; message?: string };
    debugLog.push(`  BFF error: ${url} -> ${errResult.status || errResult.message}`);
    return null;
  }

  return result as T;
}

async function fetchProducts(
  session: BrowserSession,
): Promise<BiceProduct[]> {
  const { debugLog } = session;
  debugLog.push("  Fetching products...");

  const res = await bffPostViaBrowser<BiceProductsResponse>(session, BFF_PRODUCTS);
  if (!res) return [];

  // Handle top-level array
  if (Array.isArray(res)) {
    debugLog.push(`  Products: ${(res as BiceProduct[]).length} (top-level array)`);
    return res as BiceProduct[];
  }

  const products = res.products || res.accounts || res.data || [];
  debugLog.push(`  Products: ${products.length}`);
  return products;
}

async function fetchBalance(
  session: BrowserSession,
): Promise<number | undefined> {
  const { debugLog } = session;
  debugLog.push("  Fetching balance...");

  const res = await bffPostViaBrowser<Record<string, unknown>>(session, BFF_BALANCE);
  if (!res) return undefined;

  const balance =
    (res.balance as number) ??
    (res.availableBalance as number) ??
    (res.saldo as number) ??
    (res.saldoDisponible as number);

  if (balance !== undefined && typeof balance === "number") {
    debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
    return balance;
  }

  debugLog.push(`  Balance response keys: ${Object.keys(res).join(", ")}`);
  return undefined;
}

async function fetchTransactions(
  session: BrowserSession,
): Promise<BankMovement[]> {
  const { debugLog } = session;
  debugLog.push("  Fetching transactions...");
  const allMovements: BankMovement[] = [];

  // First page
  let res = await bffPostViaBrowser<BiceTransactionsResponse>(session, BFF_TRANSACTIONS);
  if (!res) return [];

  let rawTxs: BiceTransaction[];
  if (Array.isArray(res)) {
    rawTxs = res as BiceTransaction[];
  } else {
    rawTxs = res.transactions || res.movimientos || res.data || res.content || [];
  }

  debugLog.push(`  Transactions page 1: ${rawTxs.length} items`);

  for (const tx of rawTxs) {
    const mov = biceTransactionToMovement(tx);
    if (mov) allMovements.push(mov);
  }

  // Paginate if the API supports it
  let pageNum = 2;
  const MAX_PAGES = 20;
  let hasMore = !Array.isArray(res) && (
    res.hasMore === true ||
    (res.totalPages !== undefined && pageNum <= res.totalPages)
  );

  while (hasMore && pageNum <= MAX_PAGES) {
    const pageRes = await bffPostViaBrowser<BiceTransactionsResponse>(
      session,
      BFF_TRANSACTIONS,
      { page: pageNum, pageSize: 50 },
    );

    if (!pageRes) break;

    let pageTxs: BiceTransaction[];
    if (Array.isArray(pageRes)) {
      pageTxs = pageRes as BiceTransaction[];
    } else {
      pageTxs = pageRes.transactions || pageRes.movimientos || pageRes.data || pageRes.content || [];
    }

    if (pageTxs.length === 0) break;

    debugLog.push(`  Transactions page ${pageNum}: ${pageTxs.length} items`);
    for (const tx of pageTxs) {
      const mov = biceTransactionToMovement(tx);
      if (mov) allMovements.push(mov);
    }

    pageNum++;
    hasMore = !Array.isArray(pageRes) && (
      pageRes.hasMore === true ||
      (pageRes.totalPages !== undefined && pageNum <= pageRes.totalPages)
    );
  }

  return allMovements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBice(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { debugLog, screenshot: doSave, page } = session;
  const { onProgress } = options;
  const bank = "bice";
  const progress = onProgress || (() => {});

  // 1. Login via browser (Keycloak)
  const loginResult = await biceLogin(session, options);
  if (!loginResult.success) {
    return {
      success: false,
      bank,
      movements: [],
      error: loginResult.error,
      debug: debugLog.join("\n"),
    };
  }

  progress("Sesion iniciada correctamente");

  // 2. Fetch data via BFF endpoints (using browser's session cookies)
  debugLog.push("7. Fetching data via BFF endpoints (page.evaluate + fetch)...");

  // Fetch products (account list)
  progress("Obteniendo productos...");
  const products = await fetchProducts(session);
  debugLog.push(`  Found ${products.length} product(s)`);

  // Fetch balance
  progress("Obteniendo saldo...");
  const balance = await fetchBalance(session);

  // Fetch transactions (movements)
  progress("Extrayendo movimientos...");
  const movements = await fetchTransactions(session);
  debugLog.push(`  Raw movements: ${movements.length}`);

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`8. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos totales`);

  await doSave(page, "bice-09-done");

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance: balance ?? undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const bice: BankScraper = {
  id: "bice",
  name: "Banco BICE",
  url: PORTAL_URL,
  // No mode: "api" — this is browser mode (hybrid: browser login + API data via page.evaluate).
  // The portal at portalpersonas.bice.cl returns 403 to Node.js fetch() (Cloudflare WAF).
  // Once logged in via browser, gw.bice.cl BFF endpoints work via page.evaluate(fetch(...)).
  scrape: (options) => runScraper("bice", options, {}, scrapeBice),
};

export default bice;
