import type { Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { closePopups, delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { detectLoginError } from "../actions/login.js";
import { loadCookies, saveCookies } from "../infrastructure/cookies.js";

// ─── Racional-specific constants ─────────────────────────────────

const LOGIN_URL = "https://app.racional.cl/login";

// ─── Helpers ─────────────────────────────────────────────────────

async function racionalLogin(
  page: Page,
  email: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
  onTwoFactorCode?: () => Promise<string>,
): Promise<{ success: boolean; error?: string }> {
  // Try to restore saved session first
  debugLog.push("0. Loading saved cookies...");
  const hadCookies = await loadCookies(page, "racional");
  if (hadCookies) {
    await page.goto("https://app.racional.cl/", { waitUntil: "networkidle2", timeout: 30000 });
    await delay(2000);
    if (!page.url().includes("/login")) {
      debugLog.push("  Session valid — skipping login.");
      return { success: true };
    }
    debugLog.push("  Session expired — proceeding with full login.");
  }

  debugLog.push("1. Navigating to Racional...");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(3000);
  await doSave(page, "01-login-form");

  // Find email/identifier field
  debugLog.push("2. Filling email/identifier...");
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[id*="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="correo" i]',
    'input[name="username"]',
    'input[type="text"]',
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
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de email/usuario." };
  }
  await delay(500);

  // Find password field
  debugLog.push("3. Filling password...");
  const passEl = await page.$('input[type="password"]');
  if (!passEl) {
    // Two-step: may need to submit email first
    await page.keyboard.press("Enter");
    await delay(3000);
    await doSave(page, "02-after-email");
  }

  const passEl2 = await page.$('input[type="password"]');
  if (!passEl2) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No se encontró campo de contraseña." };
  }
  await passEl2.click();
  await passEl2.type(password, { delay: 60 });
  await delay(500);

  // Submit
  debugLog.push("4. Submitting login...");
  const submitted = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
    for (const btn of btns) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || (btn as HTMLInputElement).value?.toLowerCase() || "";
      if (text.includes("ingresar") || text.includes("entrar") || text.includes("iniciar") || text.includes("login") || text.includes("continuar")) {
        (btn as HTMLElement).click();
        return true;
      }
    }
    // Fallback: first non-disabled submit button
    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    if (submitBtn && !submitBtn.disabled) { submitBtn.click(); return true; }
    return false;
  });
  if (!submitted) await page.keyboard.press("Enter");

  try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }); } catch { await delay(5000); }
  await delay(2000);
  await doSave(page, "03-post-login");

  // Detect email 2FA dialog ("Verifica tu Correo" / "código de 6 dígitos")
  const needs2FA = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    return body.includes("Verifica tu Correo") || body.includes("código de 6 dígitos") || body.includes("Verificar Código");
  });

  if (needs2FA) {
    debugLog.push("5. Email 2FA required — waiting for code...");
    await doSave(page, "03b-2fa-email");

    let code = "";
    if (onTwoFactorCode) {
      code = await onTwoFactorCode();
    } else if (process.stdin.isTTY) {
      code = await new Promise<string>((resolve) => {
        process.stderr.write("\n🔐 Racional: ingresa el código de 6 dígitos enviado a tu correo: ");
        process.stdin.once("data", (d) => resolve(d.toString().trim()));
      });
    }

    if (!code) {
      return { success: false, error: "Se requiere código 2FA de email (Racional). Proporciona onTwoFactorCode o usa TTY." };
    }

    const codeInput = await page.$('input[placeholder*="123456"], input[type="text"], input[type="number"]');
    if (codeInput) {
      await codeInput.click({ clickCount: 3 });
      await codeInput.type(code, { delay: 70 });
      await delay(300);
    }

    // Click "Verificar Código"
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      for (const btn of btns) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text.includes("verificar") || text.includes("confirmar")) {
          (btn as HTMLElement).click();
          return;
        }
      }
    });

    try { await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }); } catch { await delay(5000); }
    await delay(2000);
    await doSave(page, "04-post-2fa");
  }

  const loginError = await detectLoginError(page);
  if (loginError) return { success: false, error: `Error del banco: ${loginError}` };

  if (page.url().includes("/login")) {
    return { success: false, error: "Login no completado — URL sigue en /login." };
  }

  await saveCookies(page, "racional");
  debugLog.push("5. Login OK! Session cookies saved.");
  return { success: true };
}

async function extractRacionalMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  // Navigate to movements/activity section
  const navClicked = await page.evaluate(() => {
    const targets = ["movimientos", "actividad", "cartola", "historial", "transacciones"];
    for (const el of Array.from(document.querySelectorAll("a, button, [role='tab']"))) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      if (targets.some(t => text.includes(t)) && text.length < 50) {
        (el as HTMLElement).click();
        return text;
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
      if (rows.length < 2) continue;
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 2) continue;
        const texts = cells.map(c => (c as HTMLElement).innerText?.trim() || "");
        const dateMatch = texts.find(t => /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/.test(t));
        const amountMatch = texts.find(t => /[+\-]?[\d.,]+/.test(t) && t !== dateMatch);
        if (dateMatch && amountMatch) {
          const desc = texts.find(t => t !== dateMatch && t !== amountMatch && t.length > 2) || "";
          results.push({ date: dateMatch, description: desc, amount: amountMatch, balance: "" });
        }
      }
    }

    // Strategy 2: Movement cards/list items
    if (results.length === 0) {
      const cards = document.querySelectorAll(
        '[class*="movimiento"], [class*="movement"], [class*="transaction"], [class*="activity"], [class*="item"]'
      );
      for (const card of Array.from(cards)) {
        const text = (card as HTMLElement).innerText || "";
        const dateMatch = text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/);
        const amountMatch = text.match(/[+\-]?\$?\s*[\d.,]+/);
        if (dateMatch && amountMatch) {
          const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
          const desc = lines.find(l => !l.match(/^\d{1,2}[\/\-\.]/) && !l.match(/^\$/) && l.length > 2) || "";
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
        balance: r.balance ? parseChileanAmount(r.balance) : 0,
        source: MOVEMENT_SOURCE.account,
      } as BankMovement;
    })
    .filter(Boolean) as BankMovement[];
}

// ─── Main scrape function ─────────────────────────────────────────

async function scrapeRacional(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut: email, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const bank = "racional";
  const progress = onProgress || (() => {});

  progress("Abriendo Racional...");
  const loginResult = await racionalLogin(page, email, password, debugLog, doSave, options.onTwoFactorCode);
  if (!loginResult.success) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, movements: [], error: loginResult.error, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await delay(2000);

  progress("Extrayendo movimientos...");
  debugLog.push("6. Extracting movements...");
  const movements = await extractRacionalMovements(page, debugLog);

  // Pagination
  for (let i = 0; i < 10; i++) {
    const hasMore = await page.evaluate(() => {
      for (const btn of Array.from(document.querySelectorAll("button, a"))) {
        const text = (btn as HTMLElement).innerText?.trim().toLowerCase();
        const el = btn as HTMLButtonElement;
        if ((text === "siguiente" || text === "ver más" || text === "cargar más") && !el.disabled) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!hasMore) break;
    await delay(2500);
    const more = await extractRacionalMovements(page, debugLog);
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

const racional: BankScraper = {
  id: "racional",
  name: "Racional",
  url: LOGIN_URL,
  scrape: (options) => runScraper("racional", options, {}, scrapeRacional),
};

export default racional;
