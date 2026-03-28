import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, deduplicateMovements, delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import type { Page, Response } from "playwright-core";

// ─── BICE constants ─────────────────────────────────────────────
//
// Auth: Keycloak OIDC at auth.bice.cl/realms/personas
// Gateway: gw.bice.cl (OAuth agent proxy + BFF endpoints)
//
// Architecture: Hybrid browser + response interception
//   1. Browser login (Playwright) — navigate to portal, fill Keycloak form
//   2. Register response interception BEFORE navigation to capture API calls
//   3. Navigate to movements page — Angular SPA calls BFF endpoints
//   4. Read intercepted responses (balance, transactions, products)
//
// Why response interception instead of page.evaluate(fetch(...))?
// The gw.bice.cl endpoints return 401 when called via page.evaluate(fetch(...))
// because cross-origin cookies aren't sent. But the Angular SPA itself calls
// these endpoints successfully. By intercepting the SPA's own responses, we
// capture the data the app already fetched.

const PORTAL_URL = "https://portalpersonas.bice.cl";
const MOVEMENTS_URL = "https://portalpersonas.bice.cl/movimientos-cc";
const GW_PREFIX = "gw.bice.cl";

const TWO_FACTOR_KEYWORDS = ["otp", "two-factor", "segundo factor", "verificaci", "authenticator", "kc-form-otp"];

// ─── Response interception ──────────────────────────────────────

/** Key extracted from a gw.bice.cl URL by stripping the base path and query string. */
function responseKey(url: string): string {
  const withoutQuery = url.split("?")[0];
  const idx = withoutQuery.indexOf("/portalpersonas/");
  if (idx >= 0) return withoutQuery.slice(idx + "/portalpersonas/".length);
  return withoutQuery;
}

function setupResponseInterception(page: Page, apiResponses: Map<string, unknown>, debugLog: string[]): void {
  page.on("response", async (res: Response) => {
    const url = res.url();
    if (!url.includes(GW_PREFIX) || res.status() !== 200) return;
    try {
      const contentType = res.headers()["content-type"] || "";
      if (!contentType.includes("application/json")) return;
      const body = await res.json();
      const key = responseKey(url);
      apiResponses.set(key, body);
      debugLog.push(`  [intercept] ${key} (${res.status()})`);
    } catch {
      // Response body may not be available (e.g. redirect or stream error)
    }
  });
}

// ─── Login via browser (Keycloak) ────────────────────────────────

/**
 * Polls for a selector to appear, tolerating Cloudflare challenge pages
 * that may load before the actual Keycloak form.
 */
async function waitForSelectorPolling(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await page.$(selector);
    if (found) return true;
    await delay(2000);
  }
  return false;
}

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
  await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

  // Poll for Keycloak redirect — the Angular SPA redirects client-side
  let onKeycloak = false;
  for (let i = 0; i < 15; i++) {
    await delay(2000);
    const url = page.url();
    if (url.includes("auth.bice.cl")) {
      onKeycloak = true;
      debugLog.push(`  Redirected to Keycloak after ${(i + 1) * 2}s`);
      break;
    }
    // Check if login form appeared (might already be on Keycloak)
    const hasLogin = await page.$("#username");
    if (hasLogin) {
      onKeycloak = true;
      debugLog.push(`  Login form found after ${(i + 1) * 2}s`);
      break;
    }
  }

  await doSave(page, "bice-01-after-navigate");
  const currentUrl = page.url();
  debugLog.push(`  Landed on: ${currentUrl}`);

  if (!onKeycloak) {
      const pageText = await page.innerText("body").catch(() => "");
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

  await doSave(page, "bice-02-keycloak-page");
  debugLog.push("2. On Keycloak login page");

  // Step 2: Wait for the #username field with polling (handles Cloudflare challenge)
  // Cloudflare may show a challenge page before the Keycloak form loads.
  // Polling avoids a hard timeout on waitForSelector when the challenge is active.
  debugLog.push("  Waiting for #username field (polling, handles Cloudflare)...");
  const usernameFound = await waitForSelectorPolling(page, "#username", 30_000);

  if (!usernameFound) {
    const hasInput = await page.$$("input[type='text'], input[name='username']").then(els => els.length > 0);
    if (!hasInput) {
      await doSave(page, "bice-03-no-username-field");
      return {
        success: false,
        error: "No se encontro el campo de RUT (#username) en la pagina de Keycloak.",
      };
    }
  }

  // Step 3: Fill Keycloak login form
  debugLog.push("3. Entering credentials...");
  progress("Ingresando credenciales...");

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

  // Step 4: Click the login button
  debugLog.push("4. Clicking login button...");
  progress("Autenticando...");

  // Try clicking #kc-login first (standard Keycloak submit button)
  const kcLoginBtn = await page.$("#kc-login");
  if (kcLoginBtn) {
    await kcLoginBtn.click();
    debugLog.push("  Clicked: kc-login");
  } else {
    // Fallback: look for "Ingresar" / "Login" button
    const allButtons = await page.$$("button, input[type='submit']");
    let clicked = false;
    for (const btn of allButtons) {
      const text = await btn.innerText().catch(() => "");
      const value = await btn.getAttribute("value") || "";
      const lower = (text + " " + value).toLowerCase();
      if (lower.includes("ingresar") || lower.includes("login")) {
        await btn.click();
        debugLog.push("  Clicked: fallback-btn");
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await page.keyboard.press("Enter");
      debugLog.push("  Pressed Enter (no login button found)");
    }
  }

  // Step 5: Wait for response (redirect back to portal, error, or 2FA)
  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {
    // Navigation might already have completed or be slow
    await delay(5000);
  }
  await doSave(page, "bice-06-after-login-submit");

  const postLoginUrl = page.url();
  debugLog.push(`  Post-login URL: ${postLoginUrl}`);

  // Still on Keycloak? Check for errors or 2FA
  if (postLoginUrl.includes("auth.bice.cl")) {
    const pageHtml = await page.content();
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
      const otpInput = await page.$("#otp")
        || await page.$("input[name='otp']")
        || await page.$("input[name='totp']");

      if (otpInput) {
        await otpInput.fill(code);
      } else {
        // Fallback: type into the first visible text input
        const inputs = await page.$$("input[type='text'], input[type='number'], input:not([type])");
        if (inputs.length > 0) {
          await inputs[0].type(code, { delay: 60 });
        }
      }

      // Click submit button
      const submitBtn = await page.$("#kc-login") || await page.$("input[type='submit']");
      if (submitBtn) await submitBtn.click();

      try {
        await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch {
        await delay(5000);
      }

      const post2faUrl = page.url();
      debugLog.push(`  Post-2FA URL: ${post2faUrl}`);

      if (post2faUrl.includes("auth.bice.cl")) {
        const errorEl = await page.$(".kc-feedback-text, [class*='alert'], [class*='error']");
        const errorText = errorEl ? await errorEl.innerText().catch(() => null) : null;
        return {
          success: false,
          error: `Error 2FA: ${errorText || "Codigo incorrecto o expirado."}`,
        };
      }
    } else {
      // Check for login errors (still on Keycloak but not 2FA)
      const errorEl = await page.$(".kc-feedback-text, [class*='alert'], [class*='error']");
      const errorText = errorEl ? await errorEl.innerText().catch(() => null) : null;
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

  // Step 6: Wait for the portal to fully load (Angular SPA)
  debugLog.push("5. Waiting for portal to load...");
  progress("Sesion iniciada, cargando portal...");

  const portalLoadStart = Date.now();
  const MAX_PORTAL_WAIT = 30_000;
  let portalLoaded = false;

  while (Date.now() - portalLoadStart < MAX_PORTAL_WAIT) {
    const currentUrl = page.url();
    if (currentUrl.includes("portalpersonas.bice.cl") && !currentUrl.includes("auth.bice.cl")) {
      const bodyText = await page.innerText("body").catch(() => "");
      if (bodyText.includes("Resumen") || bodyText.includes("Cuenta") || bodyText.includes("Saldo") || bodyText.length > 500) {
        portalLoaded = true;
        break;
      }
    }
    await delay(2000);
  }

  if (!portalLoaded) {
    // Check for new tabs — BICE sometimes opens the banking portal in a new tab
    const pages = session.context.pages();
    for (const p of pages) {
      const pUrl = p.url();
      if (pUrl.includes("portalpersonas.bice.cl") && pUrl !== page.url()) {
        debugLog.push(`  Found portal in another tab: ${pUrl}`);
        const hasContent = await p.innerText("body").then(
          text => text.includes("Resumen") || text.includes("Cuenta") || text.length > 500
        ).catch(() => false);
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
    debugLog.push("  Proceeding regardless...");
  }

  debugLog.push("6. Login OK!");
  return { success: true };
}

// ─── Intercepted data parsing ────────────────────────────────────

interface BiceInterceptedTransaction {
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

interface BiceInterceptedTransactionsResponse {
  movimientos?: BiceInterceptedTransaction[];
  [key: string]: unknown;
}

interface BiceInterceptedBalanceResponse {
  titulo?: string;
  monto?: string;
  saldoDisponibleMonto?: string;
  saldoDisponibleDescripcion?: string;
  saldoContableDescripcion?: string;
  [key: string]: unknown;
}

function parseInterceptedTransaction(tx: BiceInterceptedTransaction): BankMovement | null {
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

// ─── DOM fallback extraction ─────────────────────────────────────

async function extractMovementsFromDom(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("  Attempting DOM fallback extraction...");
  const movements: BankMovement[] = [];

  try {
    const rows = await page.$$("table tbody tr");

    for (const row of rows) {
      const cells = await row.$$("td");
      if (cells.length < 3) continue;

      const cellTexts: string[] = [];
      for (const cell of cells) {
        const text = await cell.innerText().catch(() => "");
        cellTexts.push(text.trim());
      }

      const date = cellTexts[0];
      const description = cellTexts[1];
      const cargo = cellTexts[2] ? parseInt(cellTexts[2].replace(/[^0-9]/g, ""), 10) || 0 : 0;
      const abono = cellTexts[3] ? parseInt(cellTexts[3].replace(/[^0-9]/g, ""), 10) || 0 : 0;
      const balance = cellTexts[4] ? parseInt(cellTexts[4].replace(/[^0-9]/g, ""), 10) || 0 : 0;

      if (!date || !description) continue;

      const amount = abono > 0 ? abono : cargo > 0 ? -cargo : 0;
      if (amount === 0) continue;

      movements.push({
        date: normalizeDate(date),
        description,
        amount,
        balance,
        source: MOVEMENT_SOURCE.account,
      });
    }

    debugLog.push(`  DOM fallback: ${movements.length} movements`);
  } catch (err) {
    debugLog.push(`  DOM fallback failed: ${err}`);
  }

  return movements;
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

  // Set up response interception BEFORE any navigation
  // This captures all gw.bice.cl API responses that the Angular SPA makes
  const apiResponses = new Map<string, unknown>();
  setupResponseInterception(page, apiResponses, debugLog);

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

  // 2. Navigate to movements page — the Angular SPA will call BFF endpoints
  debugLog.push("7. Navigating to movements page...");
  progress("Cargando movimientos...");

  // Also set up interception on any new pages (BICE may open a new tab)
  const allPages = session.context.pages();
  for (const p of allPages) {
    if (p !== page) {
      setupResponseInterception(p, apiResponses, debugLog);
    }
  }

  // Find the right page to use (BICE sometimes opens portal in a new tab)
  let activePage = page;
  for (const p of allPages) {
    if (p.url().includes("portalpersonas.bice.cl") && p !== page) {
      activePage = p;
      debugLog.push(`  Using portal page from tab: ${p.url()}`);
      break;
    }
  }

  try {
    await activePage.goto(MOVEMENTS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {
    debugLog.push("  Navigation to movements page timed out, continuing...");
  }

  // Wait for the SPA to load data (API calls happen after Angular bootstraps)
  debugLog.push("  Waiting for SPA to fetch data...");
  const dataWaitStart = Date.now();
  const MAX_DATA_WAIT = 15_000;

  while (Date.now() - dataWaitStart < MAX_DATA_WAIT) {
    // Check if we got the transactions response
    const hasTransactions = [...apiResponses.keys()].some(k =>
      k.includes("bff-checking-account-transactions-100/v1/transactions")
    );
    if (hasTransactions) {
      debugLog.push("  Transactions response intercepted!");
      // Wait a bit more for balance to arrive too
      await delay(2000);
      break;
    }
    await delay(2000);
  }

  await doSave(activePage, "bice-09-movements-page");

  // 3. Extract data from intercepted responses
  debugLog.push("8. Extracting data from intercepted API responses...");
  debugLog.push(`  Intercepted keys: ${[...apiResponses.keys()].join(", ")}`);

  // --- Balance ---
  let balance: number | undefined;
  const balanceKey = [...apiResponses.keys()].find(k =>
    k.includes("bff-checking-account-transactions-100/v1/balance")
  );
  if (balanceKey) {
    const balanceData = apiResponses.get(balanceKey) as BiceInterceptedBalanceResponse;
    const rawBalance = balanceData?.saldoDisponibleMonto || balanceData?.monto;
    if (rawBalance) {
      balance = parseInt(rawBalance, 10);
      debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
    } else {
      debugLog.push(`  Balance response found but no saldoDisponibleMonto: ${JSON.stringify(balanceData).slice(0, 200)}`);
    }
  } else {
    debugLog.push("  No balance response intercepted");
  }

  // --- Transactions ---
  let movements: BankMovement[] = [];
  const txKey = [...apiResponses.keys()].find(k =>
    k.includes("bff-checking-account-transactions-100/v1/transactions")
  );
  if (txKey) {
    const txData = apiResponses.get(txKey) as BiceInterceptedTransactionsResponse;
    const rawMovimientos = txData?.movimientos || [];
    debugLog.push(`  Raw transactions: ${rawMovimientos.length}`);

    for (const tx of rawMovimientos) {
      const mov = parseInterceptedTransaction(tx);
      if (mov) movements.push(mov);
    }
    debugLog.push(`  Parsed movements: ${movements.length}`);
  } else {
    debugLog.push("  No transactions response intercepted");
  }

  // --- Products (log for debugging) ---
  const productsKey = [...apiResponses.keys()].find(k =>
    k.includes("bff-portal-hbp/v1/products")
  );
  if (productsKey) {
    const productsData = apiResponses.get(productsKey) as Record<string, unknown>;
    debugLog.push(`  Products intercepted: ${JSON.stringify(productsData).slice(0, 300)}`);
  }

  // 4. Fallback: if interception missed transactions, try DOM extraction
  if (movements.length === 0) {
    debugLog.push("  No intercepted transactions -- trying DOM fallback...");
    movements = await extractMovementsFromDom(activePage, debugLog);
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`9. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos totales`);

  await doSave(activePage, "bice-10-done");

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const bice: BankScraper = {
  id: "bice",
  name: "Banco BICE",
  url: PORTAL_URL,
  // Hybrid browser mode: browser login (Keycloak) + response interception for data.
  // The portal at portalpersonas.bice.cl returns 403 to Node.js fetch() (Cloudflare WAF).
  // Once logged in via browser, we intercept the Angular SPA's own API responses from gw.bice.cl.
  scrape: (options) => runScraper("bice", options, {}, scrapeBice),
};

export default bice;
