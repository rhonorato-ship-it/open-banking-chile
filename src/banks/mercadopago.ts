import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detectLoginError } from "../actions/login.js";

// ─── MercadoPago-specific constants ──────────────────────────────

// MercadoLibre Chile SSO — redirects to mercadopago.com.cl after login
const LOGIN_URL = "https://www.mercadolibre.com/jms/mlc/lgz/msl/login/H4sIAAAAAAAAAzWOwQ6CMAxAf6XpOfUHgBpOxpuZV9MDwGCDJKwkLAfj34tuHtp37zWtrTNzP0MSdHXvnb2A0jToSaFzIDEMloFh5bT5VBxOzY_cDlBrFYGiiqJIcAFz2dPnBF8fh0d4P7tg04pKjlWkJ47wr2pJ5w5DDoFXqoFPdLbqT2q1J7hkHl6x2n9lWaFCsgAAAA/user-legal-id-social";
const ACTIVITIES_URL = "https://www.mercadopago.cl/activities";

// ─── Helpers ─────────────────────────────────────────────────────

async function mercadopagoLogin(
  page: Page,
  identifier: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string }> {
  debugLog.push("1. Navigating to MercadoLibre login...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await delay(4000);
  await doSave(page, "01-login-form");

  // MercadoLibre login accepts RUN (RUT), email, or phone
  // Andes design system: form fields use data-andes-* attributes
  debugLog.push("2. Filling identifier (RUT/email/phone)...");
  const identifierSelectors = [
    "#user_id",
    'input[name="user_id"]',
    'input[id*="user_id"]',
    'input[placeholder*="correo" i]',
    'input[placeholder*="teléfono" i]',
    'input[placeholder*="RUN" i]',
    'input[placeholder*="rut" i]',
    'input[type="email"]',
    'input[type="text"]',
  ];

  let identifierFilled = false;
  for (const sel of identifierSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(identifier, { delay: 70 });
      debugLog.push(`  Identifier field: ${sel}`);
      identifierFilled = true;
      break;
    }
  }
  if (!identifierFilled) {
    return { success: false, error: "No se encontró campo de usuario/RUT/email." };
  }
  await delay(500);

  // MercadoLibre uses a two-step login (identifier → continue → password)
  debugLog.push("3. Clicking Continue...");
  const continueClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
    for (const btn of btns) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || (btn as HTMLInputElement).value?.toLowerCase() || "";
      if (text.includes("continuar") || text === "siguiente" || text === "next") {
        (btn as HTMLElement).click();
        return true;
      }
    }
    // Fallback: first submit button
    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (submitBtn && !submitBtn.disabled) { submitBtn.click(); return true; }
    return false;
  });
  if (!continueClicked) await page.keyboard.press("Enter");

  await delay(4000);
  await doSave(page, "02-after-identifier");

  // Password field (shown after identifier step)
  debugLog.push("4. Filling password...");
  const passEl = await page.$('#password, input[name="password"], input[type="password"]');
  if (!passEl) {
    return { success: false, error: "No se encontró campo de contraseña después del identificador." };
  }
  await passEl.click();
  await passEl.type(password, { delay: 70 });
  await delay(500);

  // Submit login
  debugLog.push("5. Submitting login...");
  const submitted = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
    for (const btn of btns) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || (btn as HTMLInputElement).value?.toLowerCase() || "";
      if (text.includes("ingresar") || text.includes("entrar") || text.includes("iniciar") || text.includes("continuar")) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (submitBtn && !submitBtn.disabled) { submitBtn.click(); return true; }
    return false;
  });
  if (!submitted) await page.keyboard.press("Enter");

  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }); } catch { await delay(5000); }
  await delay(3000);
  await doSave(page, "03-post-login");

  const loginError = await detectLoginError(page);
  if (loginError) return { success: false, error: `Error del banco: ${loginError}` };

  const url = page.url();
  if (url.includes("/login") || url.includes("/lgz/") || url.includes("mercadolibre.com/jms")) {
    return { success: false, error: "Login no completado — URL sigue en login de ML." };
  }

  debugLog.push("6. Login OK!");
  return { success: true };
}

async function extractMercadopagoMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  // Navigate to activities/movements page
  const currentUrl = page.url();
  if (!currentUrl.includes("mercadopago") && !currentUrl.includes("activities")) {
    debugLog.push(`  Navigating to activities (from ${currentUrl})...`);
    await page.goto(ACTIVITIES_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(4000);
  }

  // Dismiss any auth/consent prompts
  await closePopups(page);
  await delay(1000);

  const raw = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    // Strategy 1: Andes design system rows — data-andes attributes
    const andesRows = document.querySelectorAll(
      '[data-testid*="activity"], [data-testid*="movement"], [data-testid*="transaction"], [class*="activity-row"], [class*="movement-row"]'
    );
    for (const row of Array.from(andesRows)) {
      const text = (row as HTMLElement).innerText || "";
      const dateMatch = text.match(/\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\.?\s*\d{0,4}|(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
      const amountMatch = text.match(/[+\-]?\s*\$\s*[\d.,]+/);
      if (dateMatch && amountMatch) {
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        const desc = lines.find(l => l !== dateMatch[0] && !l.match(/^\$/) && !l.match(/^[+\-]/) && l.length > 2) || "";
        results.push({ date: dateMatch[0], description: desc, amount: amountMatch[0], balance: "" });
      }
    }

    // Strategy 2: General table-based extraction
    if (results.length === 0) {
      for (const table of Array.from(document.querySelectorAll("table"))) {
        const rows = Array.from(table.querySelectorAll("tr"));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll("td"));
          if (cells.length < 2) continue;
          const texts = cells.map(c => (c as HTMLElement).innerText?.trim() || "");
          const dateIdx = texts.findIndex(t => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(t));
          const amountIdx = texts.findIndex(t => /[+\-]?\$[\d.,]+/.test(t));
          if (dateIdx >= 0 && amountIdx >= 0) {
            const desc = texts.find((t, i) => i !== dateIdx && i !== amountIdx && t.length > 2) || "";
            results.push({ date: texts[dateIdx], description: desc, amount: texts[amountIdx], balance: "" });
          }
        }
      }
    }

    // Strategy 3: List items / cards
    if (results.length === 0) {
      const cards = document.querySelectorAll("li, article, [class*='card'], [class*='item']");
      for (const card of Array.from(cards)) {
        const text = (card as HTMLElement).innerText || "";
        const dateMatch = text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/);
        const amountMatch = text.match(/[+\-]?\s*\$\s*[\d.,]+/);
        if (dateMatch && amountMatch && text.length < 300) {
          const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
          const desc = lines.find(l => l !== dateMatch[0] && !l.match(/^\$/) && l.length > 2) || "";
          results.push({ date: dateMatch[0], description: desc, amount: amountMatch[0], balance: "" });
        }
      }
    }

    return results;
  });

  return raw
    .map(r => {
      const amount = parseChileanAmount(r.amount);
      if (amount === 0) return null;
      return {
        date: normalizeDate(r.date),
        description: r.description,
        amount,
        balance: 0,
        source: MOVEMENT_SOURCE.account,
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];
}

// ─── Main scrape function ─────────────────────────────────────────

async function scrapeMercadopago(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut: identifier, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "mercadopago";
  const progress = onProgress || (() => {});

  progress("Abriendo MercadoPago...");
  const loginResult = await mercadopagoLogin(page, identifier, password, debugLog, doSave);
  if (!loginResult.success) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: loginResult.error, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await delay(2000);

  progress("Extrayendo movimientos...");
  debugLog.push("7. Extracting movements...");
  const movements = await extractMercadopagoMovements(page, debugLog);

  // Load more / pagination
  for (let i = 0; i < 10; i++) {
    const hasMore = await page.evaluate(() => {
      for (const btn of Array.from(document.querySelectorAll("button, a"))) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        const el = btn as HTMLButtonElement;
        if ((text === "ver más" || text === "cargar más" || text?.includes("más movimientos") || text?.includes("ver todos")) && !el.disabled) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!hasMore) break;
    await delay(2500);
    const more = await extractMercadopagoMovements(page, debugLog);
    if (more.length === 0) break;
    movements.push(...more);
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`  Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  await doSave(page, "05-final");
  const ss = doScreenshots ? await page.screenshot({ encoding: "base64" }) as string : undefined;

  return { success: true, bank, movements: deduplicated, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ───────────────────────────────────────────────────────

const mercadopago: BankScraper = {
  id: "mercadopago",
  name: "MercadoPago",
  url: "https://www.mercadopago.cl",
  scrape: (options) => runScraper("mercadopago", options, {}, scrapeMercadopago),
};

export default mercadopago;
