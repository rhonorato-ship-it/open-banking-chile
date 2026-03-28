import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { deduplicateMovements, delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── Citibank constants ─────────────────────────────────────────
//
// Auth: Angular SPA at www.citi.com — password is E2E encrypted client-side
//       so we MUST use browser mode (no fetch-based login possible).
// Data: Try REST API + CSV download first (session cookies from browser),
//       fall back to DOM scraping if API endpoints fail.
// Bot protection: ThreatMetrix/LexisNexis ioBlackBox — handled by letting
//       the real page scripts populate it before we submit.

const LOGIN_URL = "https://www.citi.com";
const ACCOUNTS_API = "https://online.citi.com/US/REST/accountsPanel/getCustomerAccounts.jws";
const CSV_DOWNLOAD_URL = "https://online.citi.com/US/NCSC/dcd/StatementDownload.do";

// 2FA detection keywords (Citi sends SMS/email OTP)
const TWO_FACTOR_KEYWORDS = [
  "verification code",
  "one-time",
  "verify your identity",
  "security code",
  "one time password",
  "we sent",
  "enter the code",
  "codigo de verificacion",
  "otp",
];

// ─── US-format parsing helpers ──────────────────────────────────
// Citi is a US bank — amounts are in $1,234.56 format and dates are MM/DD/YYYY

/** Parse a US-format amount like "$1,234.56" or "-$50.00" to integer cents-free value */
function parseUSAmount(text: string): number {
  const clean = text.replace(/[^0-9.,-]/g, "");
  if (!clean) return 0;
  const isNegative = clean.startsWith("-") || text.includes("-$");
  // Remove commas (thousand separators), keep dot as decimal
  const normalized = clean.replace(/-/g, "").replace(/,/g, "");
  const amount = parseFloat(normalized) || 0;
  // Round to 2 decimal places to avoid floating point issues
  const rounded = Math.round(amount * 100) / 100;
  return isNegative ? -rounded : rounded;
}

/** Convert US date MM/DD/YYYY to DD-MM-YYYY */
function normalizeUSDate(raw: string): string {
  const value = raw.trim();
  // MM/DD/YYYY
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const month = match[1].padStart(2, "0");
    const day = match[2].padStart(2, "0");
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${day}-${month}-${year}`;
  }
  // Already DD-MM-YYYY or other format — return as-is
  return value;
}

// ─── Login ──────────────────────────────────────────────────────

async function citiLogin(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<{ success: true } | { success: false; error: string }> {
  const { page, debugLog, screenshot: doSave } = session;
  const { rut: username, password, onProgress, onTwoFactorCode } = options;
  const progress = onProgress || (() => {});

  // Step 1: Navigate to Citi home page (Angular SPA)
  debugLog.push("1. Navigating to Citi login page...");
  progress("Abriendo portal Citibank...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await delay(3000); // Give Angular time to bootstrap
  await doSave(page, "citi-01-home-page");

  debugLog.push(`  Current URL: ${page.url()}`);

  // Step 2: Wait for the username field (Angular SPA needs to render the login form)
  debugLog.push("2. Waiting for login form to render...");
  progress("Esperando formulario de login...");

  try {
    await page.waitForSelector("#username", { state: "visible", timeout: 20_000 });
  } catch {
    // The login form might be inside an iframe
    debugLog.push("  #username not found in main frame, checking iframes...");
    const loginFrame = await findLoginFrame(session);
    if (!loginFrame) {
      await doSave(page, "citi-02-no-username-field");
      return {
        success: false,
        error: "No se encontro el campo de usuario (#username). La pagina puede haber cambiado o el SPA no cargo.",
      };
    }
    // If we found the login frame, we continue with it below
    debugLog.push("  Found login form in iframe");
  }

  await doSave(page, "citi-02-login-form-ready");

  // Determine whether to interact with main page or an iframe
  const loginTarget = await getLoginTarget(session);

  // Step 3: Wait for ioBlackBox to populate (ThreatMetrix anti-bot)
  debugLog.push("3. Waiting for ioBlackBox to populate...");
  await waitForIoBlackBox(loginTarget, debugLog);

  // Step 4: Enter username
  debugLog.push("4. Entering username...");
  progress("Ingresando credenciales...");

  const userField = await loginTarget.$("#username")
    || await loginTarget.$('[name="username"]')
    || await loginTarget.$('input[autocomplete="username"]');

  if (!userField) {
    await doSave(page, "citi-03-no-username");
    return { success: false, error: "Campo de usuario no encontrado." };
  }

  await userField.click();
  await delay(200);
  await userField.fill(username);
  await delay(500);

  // Step 5: Check for 2-step login (some Citi flows show username first, then password)
  const nextBtn = await loginTarget.$("button");
  let isTwoStep = false;
  if (nextBtn) {
    const btnText = await nextBtn.innerText().catch(() => "");
    if (/next|siguiente|continuar/i.test(btnText)) {
      debugLog.push("  Two-step login detected, clicking Next...");
      isTwoStep = true;
      await nextBtn.click();
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
      } catch { /* navigation may not happen */ }
      await delay(3000);
    }
  }

  // Step 6: Enter password
  debugLog.push("5. Entering password...");

  // Re-acquire the login target in case the page changed after "Next"
  const passTarget = isTwoStep ? await getLoginTarget(session) : loginTarget;

  const passField = await passTarget.$("#password")
    || await passTarget.$('[name="password"]')
    || await passTarget.$('input[type="password"]')
    || await passTarget.$('input[autocomplete="current-password"]');

  if (!passField) {
    await doSave(page, "citi-04-no-password");
    return { success: false, error: "Campo de clave no encontrado (#password)." };
  }

  await passField.click();
  await delay(200);
  await passField.fill(password);
  await delay(500);
  await doSave(page, "citi-04-credentials-filled");

  // Step 7: Click Sign On
  debugLog.push("6. Clicking Sign On...");
  progress("Autenticando...");

  const submitClicked = await clickSubmitButton(passTarget, debugLog);
  if (!submitClicked) {
    // Last resort: press Enter
    await page.keyboard.press("Enter");
    debugLog.push("  Pressed Enter (no submit button found)");
  }

  // Step 8: Wait for navigation after login
  try {
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
  } catch {
    // Navigation might have already completed or be in progress
    await delay(5000);
  }
  await delay(3000);
  await doSave(page, "citi-05-after-login");

  const postLoginUrl = page.url();
  debugLog.push(`  Post-login URL: ${postLoginUrl}`);

  // Step 9: Check for login errors
  const errorMsg = await detectLoginError(page);
  if (errorMsg) {
    return { success: false, error: `Error de login: ${errorMsg}` };
  }

  // Step 10: Check for 2FA/MFA challenge
  const bodyText = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
  const needs2FA = TWO_FACTOR_KEYWORDS.some(kw => bodyText.includes(kw));

  if (needs2FA) {
    debugLog.push("7. 2FA challenge detected (OTP via SMS/email)...");
    progress("Se requiere codigo de verificacion...");
    await doSave(page, "citi-06-2fa-challenge");

    if (!onTwoFactorCode) {
      return {
        success: false,
        error: "Se requiere codigo de verificacion (2FA) pero no se proporciono callback onTwoFactorCode.",
      };
    }

    const code = await onTwoFactorCode();
    debugLog.push(`  2FA code received (length: ${code.length})`);

    // Find the OTP input field and enter the code
    const otpField = await page.$('input[type="tel"]')
      || await page.$('input[type="text"][maxlength="6"]')
      || await page.$('input[id*="otp" i]')
      || await page.$('input[id*="code" i]')
      || await page.$('input[name*="otp" i]')
      || await page.$('input[name*="code" i]')
      || await page.$('input[name*="verification" i]');

    if (!otpField) {
      await doSave(page, "citi-07-no-otp-field");
      return { success: false, error: "No se encontro el campo de codigo OTP." };
    }

    await otpField.click();
    await delay(200);
    await otpField.fill(code);
    await delay(500);

    // Submit the 2FA form
    const submitBtn = await page.$("#continueBtn")
      || await page.$("button[type='submit']");

    if (submitBtn) {
      await submitBtn.click();
    } else {
      // Try clicking any button with verify/continue text
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
        for (const btn of buttons) {
          const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
          const value = (btn as HTMLInputElement).value?.toLowerCase() || "";
          if (/verify|continue|submit|enviar|verificar|continuar/i.test(text + value)) {
            (btn as HTMLElement).click();
            return;
          }
        }
      });
    }

    try {
      await page.waitForLoadState("networkidle", { timeout: 30_000 });
    } catch {
      await delay(5000);
    }
    await delay(3000);
    await doSave(page, "citi-07-after-2fa");

    // Check if 2FA was rejected
    const post2FAText = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
    if (TWO_FACTOR_KEYWORDS.some(kw => post2FAText.includes(kw))) {
      return { success: false, error: "Codigo de verificacion rechazado o expirado." };
    }

    const post2FAError = await detectLoginError(page);
    if (post2FAError) {
      return { success: false, error: `Error 2FA: ${post2FAError}` };
    }
  }

  // Step 11: Verify we are logged in
  const finalUrl = page.url();
  debugLog.push(`  Final URL: ${finalUrl}`);

  const isLoggedIn =
    finalUrl.includes("citi.com") &&
    !finalUrl.includes("login") &&
    !finalUrl.includes("signon") &&
    !finalUrl.endsWith("www.citi.com/us");

  if (!isLoggedIn) {
    // Check if the page content suggests we are logged in despite the URL
    const dashboardText = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
    const hasDashboard = dashboardText.includes("account") || dashboardText.includes("balance")
      || dashboardText.includes("welcome") || dashboardText.includes("dashboard");

    if (!hasDashboard) {
      await doSave(page, "citi-08-login-failed");
      return {
        success: false,
        error: `Login no completado. URL final: ${finalUrl}. Posible bloqueo por ThreatMetrix/ioBlackBox.`,
      };
    }
  }

  debugLog.push("  Login OK!");
  return { success: true };
}

// ─── Login helpers ──────────────────────────────────────────────

/** Find an iframe containing the login form */
async function findLoginFrame(session: BrowserSession): Promise<import("playwright-core").Frame | null> {
  const { page } = session;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const hasUser = await frame.$("#username").catch(() => null)
      || await frame.$('[name="username"]').catch(() => null);
    if (hasUser) return frame;
  }
  return null;
}

/** Get the appropriate target (page or iframe) for login interaction */
async function getLoginTarget(session: BrowserSession): Promise<import("playwright-core").Page | import("playwright-core").Frame> {
  const { page } = session;
  // Check main page first
  const mainUser = await page.$("#username").catch(() => null);
  if (mainUser) return page;
  // Check iframes
  const frame = await findLoginFrame(session);
  if (frame) return frame;
  // Default to page
  return page;
}

/** Wait for ioBlackBox (ThreatMetrix) to populate before submitting */
async function waitForIoBlackBox(
  target: import("playwright-core").Page | import("playwright-core").Frame,
  debugLog: string[],
): Promise<void> {
  const selectors = '[name="ioBlackBox"], #ioBlackBox, input[id*="blackbox" i]';
  const maxWait = 8000;
  const interval = 300;
  let elapsed = 0;

  while (elapsed < maxWait) {
    const populated = await target.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      return el ? el.value.length > 10 : false;
    }, selectors).catch(() => false);

    if (populated) {
      debugLog.push("  ioBlackBox populated successfully");
      return;
    }
    await delay(interval);
    elapsed += interval;
  }

  debugLog.push("  Warning: ioBlackBox did not populate before submit (continuing best effort)");
}

/** Click the sign-on submit button */
async function clickSubmitButton(
  target: import("playwright-core").Page | import("playwright-core").Frame,
  debugLog: string[],
): Promise<boolean> {
  // Primary: #signInBtn
  const signInBtn = await target.$("#signInBtn");
  if (signInBtn) {
    await signInBtn.click();
    debugLog.push("  Clicked #signInBtn");
    return true;
  }

  // Fallback: button with sign-on text
  const clicked = await target.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a.btn"));
    for (const btn of buttons) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      const value = (btn as HTMLInputElement).value?.toLowerCase() || "";
      if (/sign on|sign in|ingresar|entrar/i.test(text + " " + value)) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (clicked) {
    debugLog.push("  Clicked sign-on button (text match)");
    return true;
  }

  return false;
}

/** Detect login error messages on the page */
async function detectLoginError(page: import("playwright-core").Page): Promise<string | null> {
  return page.evaluate(() => {
    const errorSelectors = [".error", '[class*="error"]', '[role="alert"]', ".errorMessage", "#errorMsg"];
    const errorKeywords = ["incorrect", "invalid", "wrong", "failed", "incorrecto", "invalido",
      "no match", "try again", "locked", "suspended", "bloqueada"];

    for (const sel of errorSelectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim() || "";
        if (text.length < 3 || text.length > 500) continue;
        const lower = text.toLowerCase();
        if (errorKeywords.some(kw => lower.includes(kw))) {
          return text;
        }
      }
    }

    // Also check full page text for keywords (in case error is outside standard containers)
    const bodyText = (document.body?.innerText || "").toLowerCase();
    for (const kw of errorKeywords) {
      if (bodyText.includes(kw)) {
        // Try to find the specific error element
        const allEls = document.querySelectorAll("div, span, p");
        for (const el of allEls) {
          const text = (el as HTMLElement).innerText?.trim() || "";
          if (text.length > 5 && text.length < 200 && text.toLowerCase().includes(kw)) {
            return text;
          }
        }
        return `Login error detected (keyword: "${kw}")`;
      }
    }
    return null;
  });
}

// ─── CSV parsing ────────────────────────────────────────────────

function parseCitiCsv(csv: string): BankMovement[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  const movements: BankMovement[] = [];
  // Skip header row
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 4) continue;
    const date = normalizeUSDate(cols[0]);
    if (!date || !/^\d{2}-\d{2}-\d{4}$/.test(date)) continue;
    const description = cols[1] || cols[2] || "";
    const amount = parseUSAmount(cols[3] || cols[4] || "0");
    if (amount === 0) continue;
    movements.push({ date, description, amount, balance: 0, source: MOVEMENT_SOURCE.account });
  }
  return movements;
}

// ─── Data extraction (API + CSV) ────────────────────────────────

/** Try to fetch accounts and CSV via REST API using browser session cookies */
async function tryApiExtraction(
  page: import("playwright-core").Page,
  debugLog: string[],
): Promise<BankMovement[] | null> {
  debugLog.push("  Attempting REST API + CSV extraction...");

  try {
    // Step 1: Get accounts (to verify API access works)
    const accountsResponse = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        if (!res.ok) return { ok: false, status: res.status, body: "" };
        const text = await res.text();
        return { ok: true, status: res.status, body: text.slice(0, 500) };
      } catch (e) {
        return { ok: false, status: 0, body: String(e) };
      }
    }, ACCOUNTS_API);

    debugLog.push(`  Accounts API: ${accountsResponse.status} (${accountsResponse.ok ? "OK" : "FAIL"})`);

    if (!accountsResponse.ok) {
      debugLog.push("  API not accessible, will try DOM scraping");
      return null;
    }

    // Step 2: Download CSV (last 3 months)
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth() - 3, 1);
    const fmt = (d: Date) =>
      `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

    const csvUrl = `${CSV_DOWNLOAD_URL}?fromDate=${encodeURIComponent(fmt(from))}&toDate=${encodeURIComponent(fmt(today))}&downloadType=CSV`;

    const csvResponse = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          credentials: "include",
          headers: { Accept: "text/csv,text/plain,*/*" },
        });
        if (!res.ok) return { ok: false, status: res.status, body: "" };
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("text") && !contentType.includes("csv")) {
          return { ok: false, status: res.status, body: `wrong content-type: ${contentType}` };
        }
        const text = await res.text();
        return { ok: true, status: res.status, body: text };
      } catch (e) {
        return { ok: false, status: 0, body: String(e) };
      }
    }, csvUrl);

    debugLog.push(`  CSV download: ${csvResponse.status} (${csvResponse.ok ? "OK" : "FAIL"}), length: ${csvResponse.body.length}`);

    if (!csvResponse.ok || csvResponse.body.length < 10) {
      debugLog.push("  CSV not available or empty, will try DOM scraping");
      return null;
    }

    const movements = parseCitiCsv(csvResponse.body);
    debugLog.push(`  CSV parsed: ${movements.length} movements`);
    return movements.length > 0 ? movements : null;
  } catch (err) {
    debugLog.push(`  API extraction error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Data extraction (DOM scraping fallback) ────────────────────

/** Navigate to account activity page and scrape movements from the DOM */
async function domExtraction(
  session: BrowserSession,
): Promise<BankMovement[]> {
  const { page, debugLog, screenshot: doSave } = session;
  debugLog.push("  Attempting DOM scraping...");

  // Find a link to transactions/activity/account page
  const activityUrl = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a[href]"));
    const keywords = ["transaction", "movement", "account", "activity", "statement"];
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href.toLowerCase();
      if (keywords.some(kw => href.includes(kw))) {
        return (link as HTMLAnchorElement).href;
      }
    }
    return null;
  });

  if (activityUrl) {
    debugLog.push(`  Navigating to activity page: ${activityUrl}`);
    try {
      await page.goto(activityUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await delay(3000);
    } catch {
      await delay(5000);
    }
    await doSave(page, "citi-10-activity-page");
  } else {
    debugLog.push("  No activity link found, scraping current page");
  }

  // Extract movements from tables on the page
  const rawMovements = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(
      "table tbody tr, .transaction-row, .movement-row, [class*='transaction']"
    ));
    const results: Array<{ date: string; desc: string; amount: string; balance: string }> = [];

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td, .cell, [class*='cell']"));
      if (cells.length < 3) continue;

      const cellTexts = cells.map(c => (c as HTMLElement).innerText?.trim() || "");
      const dateText = cellTexts[0];

      // Accept dates in various formats
      if (!/\d{1,2}[\/-]\d{1,2}/.test(dateText)) continue;

      results.push({
        date: dateText,
        desc: cellTexts[1] || "",
        amount: cellTexts[cellTexts.length - 1] || "0",
        balance: cellTexts.length > 3 ? cellTexts[cellTexts.length - 2] || "0" : "0",
      });
    }
    return results;
  });

  debugLog.push(`  DOM scraping found ${rawMovements.length} rows`);

  const movements: BankMovement[] = [];
  for (const m of rawMovements) {
    const amount = parseUSAmount(m.amount);
    if (amount === 0) continue;
    const balance = parseUSAmount(m.balance);

    movements.push({
      date: normalizeUSDate(m.date),
      description: m.desc,
      amount,
      balance,
      source: MOVEMENT_SOURCE.account,
    });
  }

  await doSave(page, "citi-11-movements-extracted");
  return movements;
}

// ─── Main scrape function ───────────────────────────────────────

async function scrapeCiti(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "citi";
  const progress = options.onProgress || (() => {});

  // Login
  progress("Conectando con Citibank...");
  const loginResult = await citiLogin(session, options);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }
  progress("Sesion iniciada correctamente");

  // Wait for dashboard to fully load
  await delay(5000);
  await doSave(page, "citi-09-dashboard");

  // Extract movements — try API first, fall back to DOM
  debugLog.push("8. Extracting movements...");
  progress("Obteniendo movimientos...");

  let movements: BankMovement[] = [];

  // Method 1: REST API + CSV
  const apiMovements = await tryApiExtraction(page, debugLog);
  if (apiMovements && apiMovements.length > 0) {
    movements = apiMovements;
    debugLog.push(`  API extraction: ${movements.length} movements`);
  } else {
    // Method 2: DOM scraping fallback
    debugLog.push("  Falling back to DOM scraping...");
    movements = await domExtraction(session);
    debugLog.push(`  DOM extraction: ${movements.length} movements`);
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`9. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos`);

  return {
    success: true,
    bank,
    movements: deduplicated,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ─────────────────────────────────────────────────────

const citi: BankScraper = {
  id: "citi",
  name: "Citibank",
  url: "https://www.citi.com",
  // Browser mode required — password is E2E encrypted client-side in Angular SPA,
  // and ThreatMetrix/ioBlackBox requires real browser execution.
  scrape: (options) => runScraper("citi", options, {}, scrapeCiti),
};

export default citi;
