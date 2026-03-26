import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detectLoginError } from "../actions/login.js";

// ─── Fintual-specific constants ───────────────────────────────────

const LOGIN_URL = "https://fintual.cl/f/sign-in/";
const DASHBOARD_URL = "https://fintual.cl/f/";

// ─── Helpers ─────────────────────────────────────────────────────

async function fintualLogin(
  page: Page,
  email: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string }> {
  debugLog.push("1. Navigating to Fintual sign-in...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(3000);
  await doSave(page, "01-login-form");

  // Email field — Fintual uses label "Correo electrónico"
  debugLog.push("2. Filling email...");
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id*="email"]',
    'input[placeholder*="correo" i]',
    'input[placeholder*="email" i]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(email, { delay: 60 });
      debugLog.push(`  Email field: ${sel}`);
      emailFilled = true;
      break;
    }
  }
  if (!emailFilled) {
    return { success: false, error: "No se encontró campo de correo electrónico." };
  }
  await delay(500);

  // Password field — Fintual uses label "Contraseña"
  debugLog.push("3. Filling password...");
  const passEl = await page.$('input[type="password"]');
  if (!passEl) {
    return { success: false, error: "No se encontró campo de contraseña." };
  }
  await passEl.click();
  await passEl.type(password, { delay: 60 });
  await delay(500);

  // Submit — Fintual uses button "Entrar"
  debugLog.push("4. Clicking Entrar...");
  const submitted = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
    for (const btn of btns) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (text === "entrar" || text === "ingresar" || text === "iniciar sesión") {
        (btn as HTMLElement).click();
        return true;
      }
    }
    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (submitBtn && !submitBtn.disabled) { submitBtn.click(); return true; }
    return false;
  });
  if (!submitted) await page.keyboard.press("Enter");

  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }); } catch { await delay(5000); }
  await delay(2000);
  await doSave(page, "03-post-login");

  const loginError = await detectLoginError(page);
  if (loginError) return { success: false, error: `Error del banco: ${loginError}` };

  const url = page.url();
  if (url.includes("/sign-in") || url.includes("/login")) {
    return { success: false, error: "Login no completado — URL sigue en sign-in/login." };
  }

  debugLog.push("5. Login OK!");
  return { success: true };
}

async function extractFintualMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  // Navigate to movements section
  const navClicked = await page.evaluate(() => {
    const targets = ["movimientos", "historial", "actividad", "transacciones", "aportes"];
    for (const el of Array.from(document.querySelectorAll("a, button, [role='tab'], [role='link']"))) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      const href = (el as HTMLAnchorElement).href || "";
      if (targets.some(t => text.includes(t) || href.includes(t)) && text.length < 60) {
        (el as HTMLElement).click();
        return text || href;
      }
    }
    return null;
  });
  if (navClicked) {
    debugLog.push(`  Navigation: "${navClicked}"`);
    await delay(3000);
  }

  const raw = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];

    // Strategy 1: Tables
    for (const table of Array.from(document.querySelectorAll("table"))) {
      const rows = Array.from(table.querySelectorAll("tr"));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 2) continue;
        const texts = cells.map(c => (c as HTMLElement).innerText?.trim() || "");
        const dateMatch = texts.find(t => /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(t) || /\d{4}-\d{2}-\d{2}/.test(t));
        const amountMatch = texts.find(t => /[+\-]?\$?[\d.,]+/.test(t) && t !== dateMatch && t.length > 0);
        if (dateMatch && amountMatch) {
          const desc = texts.find(t => t !== dateMatch && t !== amountMatch && t.length > 2) || "";
          results.push({ date: dateMatch, description: desc, amount: amountMatch, balance: "" });
        }
      }
    }

    // Strategy 2: React list items / cards (Fintual is Next.js React)
    if (results.length === 0) {
      const cards = document.querySelectorAll(
        '[class*="movement"], [class*="transaction"], [class*="aporte"], [class*="rescate"], li, article'
      );
      for (const card of Array.from(cards)) {
        const text = (card as HTMLElement).innerText || "";
        const dateMatch = text.match(/\d{1,2}\s+(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\.?\s*\d{2,4}|(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
        const amountMatch = text.match(/[+\-]?\$\s*[\d.,]+/);
        if (dateMatch && amountMatch) {
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

async function scrapeFintual(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut: email, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "fintual";
  const progress = onProgress || (() => {});

  progress("Abriendo Fintual...");
  const loginResult = await fintualLogin(page, email, password, debugLog, doSave);
  if (!loginResult.success) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: loginResult.error, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await delay(2000);

  progress("Extrayendo movimientos...");
  debugLog.push("6. Extracting movements...");
  const movements = await extractFintualMovements(page, debugLog);

  // Pagination / load more
  for (let i = 0; i < 10; i++) {
    const hasMore = await page.evaluate(() => {
      for (const btn of Array.from(document.querySelectorAll("button, a"))) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        const el = btn as HTMLButtonElement;
        if ((text === "ver más" || text === "cargar más" || text?.includes("más movimientos")) && !el.disabled) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!hasMore) break;
    await delay(2500);
    const more = await extractFintualMovements(page, debugLog);
    if (more.length === 0) break;
    movements.push(...more);
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`  Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  await doSave(page, "04-final");
  const ss = doScreenshots ? await page.screenshot({ encoding: "base64" }) as string : undefined;

  return { success: true, bank, movements: deduplicated, screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ───────────────────────────────────────────────────────

const fintual: BankScraper = {
  id: "fintual",
  name: "Fintual",
  url: DASHBOARD_URL,
  scrape: (options) => runScraper("fintual", options, {}, scrapeFintual),
};

export default fintual;
