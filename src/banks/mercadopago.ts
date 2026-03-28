import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements, delay, parseChileanAmount } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── MercadoPago browser scraper ────────────────────────────────
//
// MercadoPago / MercadoLibre login requires a browser because the
// login form uses a `dps` device fingerprint field populated by
// JavaScript (ThreatMetrix-style). Pure fetch() login is not viable.
//
// Login flow:
//   1. Navigate to mercadopago.cl/home -> redirects to ML login
//   2. Step 1: enter email, click "Continuar"
//   3. Step 2: enter password, click "Iniciar sesion"
//   4. Handle 2FA if prompted (email code, QR, facial)
//   5. Redirect back to mercadopago.cl dashboard
//
// Data extraction:
//   - Balance from the dashboard or wallet page
//   - Activity/movements from mercadopago.cl/activities

const HOME_URL = "https://www.mercadopago.cl/home";
const ACTIVITIES_URL = "https://www.mercadopago.cl/activities";

// ─── Login helpers ──────────────────────────────────────────────

async function waitForLoginForm(session: BrowserSession): Promise<void> {
  const { page, debugLog } = session;

  // Wait for the email/user_id input to appear (ML login page)
  await page.waitForSelector(
    'input[name="user_id"], input[id="user_id"], input[type="email"], input[type="text"]',
    { timeout: 30_000 },
  );
  debugLog.push("  Login form detected");
}

async function fillEmail(session: BrowserSession, email: string): Promise<void> {
  const { page, debugLog } = session;

  // Try specific ML selectors first, then generic
  const selectors = [
    'input[name="user_id"]',
    'input[id="user_id"]',
    'input[name="user-legal-id-social"]',
    'input[type="email"]',
    'input[type="text"]:not([type="hidden"])',
  ];

  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 }); // select all existing text
      await el.type(email, { delay: 40 });
      debugLog.push(`  Email entered via ${sel}`);
      return;
    }
  }

  throw new Error("No se encontro el campo de email en el formulario de login.");
}

async function clickContinue(session: BrowserSession): Promise<void> {
  const { page, debugLog } = session;

  // The ML login has a "Continuar" button after entering email
  const clicked = await page.evaluate(() => {
    // Try submit button first
    const submitBtns = Array.from(document.querySelectorAll('button[type="submit"], button'));
    for (const btn of submitBtns) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (
        text === "continuar" ||
        text === "continue" ||
        text.includes("continuar") ||
        text.includes("siguiente")
      ) {
        (btn as HTMLElement).click();
        return true;
      }
    }

    // Try submit type
    const submit = document.querySelector('button[type="submit"]') as HTMLElement | null;
    if (submit && !submit.hasAttribute("disabled")) {
      submit.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    // Fallback: press Enter
    await page.keyboard.press("Enter");
  }
  debugLog.push("  Clicked Continue/Continuar");
}

async function fillPassword(session: BrowserSession, password: string): Promise<void> {
  const { page, debugLog } = session;

  // Wait for the password field to appear (step 2 of ML login)
  await page.waitForSelector('input[type="password"]', { timeout: 15_000 });
  await delay(500); // brief pause for JS to settle

  const passEl = await page.$('input[type="password"]');
  if (!passEl) {
    throw new Error("No se encontro el campo de contrasena.");
  }

  await passEl.click();
  await passEl.type(password, { delay: 40 });
  debugLog.push("  Password entered");
}

async function clickLogin(session: BrowserSession): Promise<void> {
  const { page, debugLog } = session;

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button[type="submit"], button'));
    for (const btn of buttons) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (
        text.includes("iniciar sesi") ||
        text.includes("sign in") ||
        text.includes("ingresar") ||
        text.includes("entrar") ||
        text.includes("log in")
      ) {
        (btn as HTMLElement).click();
        return true;
      }
    }

    // Fallback: click the first submit button
    const submit = document.querySelector('button[type="submit"]') as HTMLElement | null;
    if (submit && !submit.hasAttribute("disabled")) {
      submit.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    await page.keyboard.press("Enter");
  }
  debugLog.push("  Clicked login submit");
}

// ─── 2FA handling ───────────────────────────────────────────────

const TWO_FA_KEYWORDS = [
  "codigo de verificacion",
  "codigo de seguridad",
  "verification code",
  "security code",
  "te enviamos un codigo",
  "te enviamos un c\u00f3digo",
  "ingresa el codigo",
  "ingresa el c\u00f3digo",
  "confirma tu identidad",
  "validar identidad",
  "challenge",
];

async function detect2FA(session: BrowserSession): Promise<boolean> {
  const { page } = session;
  const text = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
  return TWO_FA_KEYWORDS.some((kw) => text.includes(kw));
}

async function handle2FA(
  session: BrowserSession,
  onTwoFactorCode?: () => Promise<string>,
): Promise<void> {
  const { page, debugLog } = session;
  debugLog.push("  2FA challenge detected");

  if (!onTwoFactorCode) {
    throw new Error(
      "MercadoPago solicita verificacion 2FA pero no hay callback para obtener el codigo. " +
        "Usa la interfaz web o provee onTwoFactorCode.",
    );
  }

  const code = await onTwoFactorCode();
  if (!code) {
    throw new Error("No se recibio codigo 2FA.");
  }

  debugLog.push(`  2FA code received (${code.length} chars)`);

  // Find and fill the code input
  const codeSelectors = [
    'input[name="code"]',
    'input[name="otp"]',
    'input[name="verification_code"]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="number"]',
    'input[autocomplete="one-time-code"]',
  ];

  let filled = false;
  for (const sel of codeSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(code, { delay: 40 });
      filled = true;
      debugLog.push(`  2FA code entered via ${sel}`);
      break;
    }
  }

  // Fallback: try to find any visible text/number input that looks like a code field
  if (!filled) {
    filled = await page.evaluate((codeValue: string) => {
      const inputs = Array.from(document.querySelectorAll("input"));
      for (const input of inputs) {
        const el = input as HTMLInputElement;
        if (el.offsetParent === null || el.disabled || el.type === "hidden" || el.type === "password") continue;
        if (el.type === "text" || el.type === "tel" || el.type === "number" || !el.type) {
          el.focus();
          el.value = codeValue;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, code);
  }

  if (!filled) {
    throw new Error("No se encontro el campo para ingresar el codigo 2FA.");
  }

  // Click verify/confirm button
  await delay(500);
  const confirmed = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button, a"));
    for (const btn of buttons) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (
        text.includes("verificar") ||
        text.includes("confirmar") ||
        text.includes("validar") ||
        text.includes("verify") ||
        text.includes("confirm") ||
        text.includes("continuar") ||
        text.includes("enviar")
      ) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    const submit = document.querySelector('button[type="submit"]') as HTMLElement | null;
    if (submit) {
      submit.click();
      return true;
    }
    return false;
  });

  if (!confirmed) {
    await page.keyboard.press("Enter");
  }

  debugLog.push("  2FA submitted, waiting for redirect...");
  await delay(3000);
}

// ─── Login error detection ──────────────────────────────────────

async function detectLoginError(session: BrowserSession): Promise<string | null> {
  const { page } = session;
  const errorText = await page.evaluate(() => {
    const pattern =
      /(error|incorrect|inv[aá]lid|rechazad|bloquead|fall[oó]|intenta nuevamente|credencial|contrase[nñ]a.*incorrecta|usuario.*no.*registrado|no.*pudimos|datos.*incorrectos)/i;
    const selectors = [
      '[class*="error"]',
      '[class*="alert"]',
      '[role="alert"]',
      '[class*="warning"]',
      '[class*="message"]',
      '[data-testid*="error"]',
    ];
    for (const sel of selectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 3 && text.length < 300 && pattern.test(text)) {
          return text;
        }
      }
    }
    return null;
  });
  return errorText;
}

// ─── Data extraction ────────────────────────────────────────────

async function extractBalance(session: BrowserSession): Promise<number | undefined> {
  const { page, debugLog } = session;

  // Try to find balance on dashboard. MercadoPago shows "Dinero disponible" or "Tu dinero"
  const balance = await page.evaluate(() => {
    const text = document.body?.innerText || "";

    // Look for "Dinero disponible" / "Dinero en cuenta" / "Tu dinero" patterns
    const patterns = [
      /(?:dinero\s+disponible|dinero\s+en\s+cuenta|tu\s+dinero|saldo\s+disponible|available\s+balance)[^\d$]*\$\s*([\d.,]+)/i,
      /\$\s*([\d.,]+)\s*(?:disponible|en\s+cuenta)/i,
    ];

    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        // Parse Chilean amount: dots are thousands, comma is decimal
        const clean = m[1].replace(/\./g, "").replace(",", ".");
        const val = parseFloat(clean);
        if (!isNaN(val)) return val;
      }
    }

    // Try structured data approach: look for balance-like elements
    const candidates = document.querySelectorAll(
      '[class*="balance"], [class*="money"], [class*="amount"], [class*="wallet"], [data-testid*="balance"]',
    );
    for (const el of candidates) {
      const t = (el as HTMLElement).innerText?.trim() || "";
      const m = t.match(/\$\s*([\d.,]+)/);
      if (m) {
        const clean = m[1].replace(/\./g, "").replace(",", ".");
        const val = parseFloat(clean);
        if (!isNaN(val) && val > 0) return val;
      }
    }

    return null;
  });

  if (balance !== null && balance !== undefined) {
    debugLog.push(`  Balance: $${Math.round(balance).toLocaleString("es-CL")}`);
    return Math.round(balance);
  }

  debugLog.push("  Balance not found on dashboard");
  return undefined;
}

interface RawActivity {
  date: string;
  description: string;
  amountText: string;
  type: string; // "income" | "expense" | "unknown"
}

async function extractActivities(session: BrowserSession): Promise<BankMovement[]> {
  const { page, debugLog } = session;

  // Navigate to activities page
  debugLog.push("  Navigating to activities page...");
  await page.goto(ACTIVITIES_URL, { waitUntil: "networkidle", timeout: 30_000 });
  await delay(3000); // wait for SPA to render

  await session.screenshot(page, "mercadopago-activities");

  // Scroll down to load more activities (infinite scroll)
  let previousHeight = 0;
  for (let scroll = 0; scroll < 10; scroll++) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) break;
    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2000);
  }

  // Extract activity data from the page
  const rawActivities = await page.evaluate(() => {
    const results: Array<{
      date: string;
      description: string;
      amountText: string;
      type: string;
    }> = [];

    // Strategy 1: Look for activity list items (MercadoPago uses card/list components)
    // Activities are typically in a list with date groupings
    const listItems = document.querySelectorAll(
      '[class*="activity"], [class*="transaction"], [class*="movement"], ' +
        '[class*="row"], [class*="list-item"], [class*="operation"], ' +
        'li[class], article, [data-testid*="activity"], [data-testid*="transaction"]',
    );

    for (const item of listItems) {
      const text = (item as HTMLElement).innerText || "";
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2 || lines.length > 15) continue;

      // Find amount (look for $ sign)
      let amountLine = "";
      let amountType = "unknown";
      for (const line of lines) {
        const amountMatch = line.match(/[+-]?\s*\$\s*[\d.,]+/);
        if (amountMatch) {
          amountLine = amountMatch[0];
          // Determine if income or expense based on sign or color
          if (line.includes("+") || line.includes("recibiste") || line.includes("ingreso")) {
            amountType = "income";
          } else if (line.includes("-") || line.includes("pagaste") || line.includes("gasto") || line.includes("enviaste")) {
            amountType = "expense";
          }
          break;
        }
      }
      if (!amountLine) continue;

      // Find date
      let dateLine = "";
      for (const line of lines) {
        // Match dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
        if (/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(line)) {
          dateLine = line;
          break;
        }
        // Match "27 mar 2026", "27 de marzo de 2026", etc.
        if (/\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)/i.test(line)) {
          dateLine = line;
          break;
        }
      }

      // Find description (longest line that is not the date or amount)
      let description = "";
      for (const line of lines) {
        if (line === dateLine || line === amountLine) continue;
        if (/^[+-]?\s*\$/.test(line)) continue; // skip amount-only lines
        if (line.length > description.length && line.length > 3) {
          description = line;
        }
      }

      if (description) {
        results.push({
          date: dateLine,
          description,
          amountText: amountLine,
          type: amountType,
        });
      }
    }

    // Strategy 2: Look for date-grouped sections
    if (results.length === 0) {
      // MercadoPago may group activities by date with headers
      const allText = document.body?.innerText || "";
      const sections = allText.split(/(?=\d{1,2}\s+(?:de\s+)?(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*(?:\s+(?:de\s+)?\d{4})?)/i);

      for (const section of sections) {
        const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;

        const dateMatch = lines[0].match(
          /(\d{1,2})\s+(?:de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*(?:\s+(?:de\s+)?(\d{4}))?/i,
        );
        if (!dateMatch) continue;

        const currentDate = lines[0];

        // Find movements within this date section
        for (let i = 1; i < lines.length; i++) {
          const amountMatch = lines[i].match(/[+-]?\s*\$\s*[\d.,]+/);
          if (amountMatch) {
            const desc = lines[i - 1] && !/\$/.test(lines[i - 1]) ? lines[i - 1] : lines[i];
            results.push({
              date: currentDate,
              description: desc,
              amountText: amountMatch[0],
              type: amountMatch[0].includes("-") ? "expense" : amountMatch[0].includes("+") ? "income" : "unknown",
            });
          }
        }
      }
    }

    return results;
  }) as RawActivity[];

  debugLog.push(`  Raw activities extracted: ${rawActivities.length}`);

  // Parse into BankMovement objects
  const movements: BankMovement[] = [];
  for (const raw of rawActivities) {
    // Parse date
    let date = "";
    if (raw.date) {
      // Try direct format first
      const directMatch = raw.date.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
      if (directMatch) {
        date = normalizeDate(directMatch[0]);
      } else {
        // Try "27 mar 2026" style
        date = normalizeDate(raw.date.trim());
      }
    }
    if (!date || date === "Invalid" || !/\d{2}-\d{2}-\d{4}/.test(date)) continue;

    // Parse amount
    const amount = parseChileanAmount(raw.amountText);
    if (amount === 0) continue;

    // Determine sign based on context
    let signedAmount = amount;
    if (raw.type === "expense" && signedAmount > 0) {
      signedAmount = -signedAmount;
    } else if (raw.type === "income" && signedAmount < 0) {
      signedAmount = -signedAmount;
    }

    movements.push({
      date,
      description: raw.description.slice(0, 200), // cap description length
      amount: signedAmount,
      balance: 0,
      source: MOVEMENT_SOURCE.account,
    });
  }

  return deduplicateMovements(movements);
}

// ─── Main scrape function ───────────────────────────────────────

async function scrapeMercadopago(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { page, debugLog, screenshot: doSave } = session;
  const { rut: email, password, onProgress, onTwoFactorCode } = options;
  const bank = "mercadopago";
  const progress = onProgress || (() => {});

  // Step 1: Navigate to MercadoPago (redirects to ML login)
  debugLog.push("1. Navigating to MercadoPago home...");
  progress("Abriendo MercadoPago...");
  await page.goto(HOME_URL, { waitUntil: "networkidle", timeout: 45_000 });
  await delay(2000);
  await doSave(page, "mercadopago-01-initial");

  const currentUrl = page.url();
  debugLog.push(`  Current URL: ${currentUrl}`);

  // Check if already logged in (e.g., using --profile with active session)
  if (currentUrl.includes("mercadopago.cl/home") && !currentUrl.includes("login")) {
    debugLog.push("  Already logged in (active session detected)");
    progress("Sesion activa detectada");
  } else {
    // Step 2: Login flow
    debugLog.push("2. Starting login flow...");
    progress("Ingresando credenciales...");

    // Wait for login form
    try {
      await waitForLoginForm(session);
    } catch {
      await doSave(page, "mercadopago-02-no-login-form");
      throw new Error(
        "No se encontro el formulario de login de MercadoLibre. " +
          `URL actual: ${page.url()}`,
      );
    }

    await doSave(page, "mercadopago-02-login-form");

    // Step 2a: Enter email
    await fillEmail(session, email);
    await doSave(page, "mercadopago-03-email-filled");

    // Step 2b: Click Continue
    await clickContinue(session);
    await delay(3000);
    await doSave(page, "mercadopago-04-after-continue");

    // Check for email error (e.g., "usuario no registrado")
    const emailError = await detectLoginError(session);
    if (emailError) {
      debugLog.push(`  Login error after email: ${emailError}`);
      return {
        success: false,
        bank,
        movements: [],
        error: `Error de login: ${emailError}`,
        debug: debugLog.join("\n"),
      };
    }

    // Step 2c: Enter password
    try {
      await fillPassword(session, password);
    } catch {
      await doSave(page, "mercadopago-05-no-password-field");
      // The page might be asking for something else (CAPTCHA, phone verification)
      const bodyText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 500));
      debugLog.push(`  Page text: ${bodyText}`);
      throw new Error(
        "No se encontro el campo de contrasena. El sitio puede estar pidiendo " +
          "verificacion adicional (CAPTCHA, telefono). Intenta con --headful --profile.",
      );
    }
    await doSave(page, "mercadopago-05-password-filled");

    // Step 2d: Click login
    await clickLogin(session);
    debugLog.push("3. Login submitted, waiting for redirect...");
    progress("Autenticando...");

    // Wait for navigation after login
    try {
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 20_000 });
    } catch {
      // Navigation might have already happened or be slower
      await delay(3000);
    }
    await doSave(page, "mercadopago-06-after-login");

    // Check for login errors
    const loginError = await detectLoginError(session);
    if (loginError) {
      debugLog.push(`  Login error: ${loginError}`);
      return {
        success: false,
        bank,
        movements: [],
        error: `Error de login: ${loginError}`,
        debug: debugLog.join("\n"),
      };
    }

    // Step 3: Handle 2FA if present
    const has2FA = await detect2FA(session);
    if (has2FA) {
      debugLog.push("4. 2FA challenge detected");
      progress("Verificacion 2FA requerida...");
      await doSave(page, "mercadopago-07-2fa");
      await handle2FA(session, onTwoFactorCode);
      await doSave(page, "mercadopago-08-after-2fa");

      // Wait for redirect after 2FA
      try {
        await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15_000 });
      } catch {
        await delay(3000);
      }
    }

    // Verify we are logged in
    const postLoginUrl = page.url();
    debugLog.push(`  Post-login URL: ${postLoginUrl}`);

    if (postLoginUrl.includes("login") || postLoginUrl.includes("lgz")) {
      // Still on login page — check for additional challenges
      const stillHas2FA = await detect2FA(session);
      if (stillHas2FA) {
        debugLog.push("  Still showing 2FA challenge");
        return {
          success: false,
          bank,
          movements: [],
          error: "No se pudo completar la verificacion 2FA.",
          debug: debugLog.join("\n"),
        };
      }

      const pageError = await detectLoginError(session);
      await doSave(page, "mercadopago-09-still-login");
      return {
        success: false,
        bank,
        movements: [],
        error: pageError || "Login fallido. Verifica tus credenciales o intenta con --headful --profile.",
        debug: debugLog.join("\n"),
      };
    }
  }

  // Step 4: Logged in — extract data
  debugLog.push("5. Login successful, extracting data...");
  progress("Sesion iniciada correctamente");

  // Navigate to home/dashboard if not already there
  if (!page.url().includes("mercadopago.cl")) {
    await page.goto(HOME_URL, { waitUntil: "networkidle", timeout: 30_000 });
    await delay(2000);
  }

  await doSave(page, "mercadopago-10-dashboard");

  // Extract balance from dashboard
  debugLog.push("6. Extracting balance...");
  progress("Extrayendo saldo...");
  const balance = await extractBalance(session);

  // Extract activity/movements
  debugLog.push("7. Extracting activities...");
  progress("Extrayendo movimientos...");
  const movements = await extractActivities(session);

  debugLog.push(`8. Total: ${movements.length} movements`);
  progress(`Listo -- ${movements.length} movimientos totales`);

  if (movements.length === 0) {
    debugLog.push("  Note: 0 movements may be normal if the account has no recent activity.");
  }

  return {
    success: true,
    bank,
    movements,
    balance,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ─────────────────────────────────────────────────────

const mercadopago: BankScraper = {
  id: "mercadopago",
  name: "MercadoPago",
  url: "https://www.mercadopago.cl",
  // No mode: "api" — this is browser mode (default) because
  // MercadoLibre login requires JS device fingerprint (dps field)
  scrape: (options) => runScraper("mercadopago", options, {}, scrapeMercadopago),
};

export default mercadopago;
