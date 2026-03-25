import type { Page, Frame } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

const LOGIN_URL = "https://online.citi.com";

// ─── Login ────────────────────────────────────────────────────

async function getLoginFrame(page: Page): Promise<Frame | null> {
  await delay(1000);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const hasUser = await frame.$('#username, [name="username"]').catch(() => null);
    if (hasUser) return frame;
  }
  return null;
}

async function citiLogin(
  page: Page,
  username: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string }> {
  debugLog.push("1. Navigating to Citi...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait for Citi's Angular/authentication SDK to fully initialize
  await delay(8000);
  await doSave(page, "01-citi-login");

  debugLog.push("2. Looking for login form...");
  const frame: Frame | Page = await getLoginFrame(page) ?? page;
  debugLog.push(frame !== page ? "  Found login iframe" : "  Using main page");

  // Find username field
  const userSelectors = ['#username', '[name="username"]', 'input[autocomplete="username"]'];
  let userEl = null;
  for (const sel of userSelectors) {
    userEl = await frame.$(sel).catch(() => null);
    if (userEl) { debugLog.push(`  Username: ${sel}`); break; }
  }
  if (!userEl) {
    await doSave(page, "02-citi-no-user-field");
    return { success: false, error: "No se encontró campo de usuario. Usa --screenshots para diagnosticar." };
  }

  // Get center coordinates for natural mouse interaction
  const userPos = await frame.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, userEl);

  // Natural mouse movement + keyboard typing (React synthetic events compatible)
  await page.mouse.move(userPos.x - 40, userPos.y - 20, { steps: 8 });
  await delay(150);
  await page.mouse.click(userPos.x, userPos.y);
  await delay(400);
  await page.keyboard.type(username, { delay: 90 });
  await delay(500);
  await doSave(page, "03-citi-username-typed");

  // Find password field
  const passSelectors = ['#password', '[name="password"]', 'input[type="password"]', 'input[autocomplete="current-password"]'];
  let passEl = null;
  for (const sel of passSelectors) {
    passEl = await frame.$(sel).catch(() => null);
    if (passEl) { debugLog.push(`  Password: ${sel}`); break; }
  }
  if (!passEl) {
    await doSave(page, "03-citi-no-pass-field");
    return { success: false, error: "No se encontró campo de contraseña." };
  }

  const passPos = await frame.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, passEl);

  await page.mouse.move(passPos.x, passPos.y, { steps: 8 });
  await page.mouse.click(passPos.x, passPos.y);
  await delay(400);
  await page.keyboard.type(password, { delay: 90 });

  // Give React time to validate before submitting
  await delay(2000);
  await doSave(page, "04-citi-pre-submit");
  debugLog.push("3. Submitting...");

  // Find and click the Sign On button (id="signInBtn" on citi.com)
  const btnPos = await frame.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('#signInBtn') ||
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === "Sign On");
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });

  const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => null);
  if (btnPos) {
    await page.mouse.move(btnPos.x - 15, btnPos.y - 5, { steps: 6 });
    await delay(150);
    await page.mouse.click(btnPos.x, btnPos.y);
    debugLog.push(`  Clicked Sign On at ${btnPos.x},${btnPos.y}`);
  } else {
    await page.keyboard.press("Enter");
    debugLog.push("  Submit via Enter");
  }
  await navPromise;
  await delay(3000);
  debugLog.push(`  URL: ${page.url()}`);
  await doSave(page, "05-citi-after-login");

  // Check for auth errors
  const errorText = await page.evaluate(() => {
    const errorKw = ["incorrect", "invalid", "wrong", "failed", "incorrecto", "inválido"];
    for (const sel of ['.error', '[class*="error"]', '[role="alert"]', '.errorMessage', '#errorMsg']) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const txt = (el as HTMLElement).innerText?.trim();
        if (txt && errorKw.some((kw) => txt.toLowerCase().includes(kw))) return txt;
      }
    }
    return null;
  });
  if (errorText) return { success: false, error: `Error de login: ${errorText}` };

  // Successful login goes to online.citi.com
  const url = page.url();
  if (!url.includes("online.citi.com")) {
    await doSave(page, "06-citi-stuck-login");
    return { success: false, error: `Login no completado (URL: ${url}). Usa --screenshots para diagnosticar.` };
  }

  debugLog.push("4. Login OK!");
  return { success: true };
}

// ─── Extraction ───────────────────────────────────────────────

async function extractMovements(page: Page, debugLog: string[], doSave: (page: Page, name: string) => Promise<void>): Promise<BankMovement[]> {
  debugLog.push("5. Extracting movements...");
  // Wait for Citi's SPA to fully render the dashboard
  await delay(5000);
  debugLog.push(`  Dashboard URL: ${page.url()}`);
  await doSave(page, "07-citi-dashboard");

  // Log available links for debugging
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ text: (a as HTMLElement).innerText?.trim().slice(0, 40), href: (a as HTMLAnchorElement).href }))
      .filter((l) => l.text && l.href)
      .slice(0, 20)
  );
  debugLog.push(`  Links: ${JSON.stringify(links)}`);

  // Try to navigate to transactions/accounts page
  const movHrefs = links.filter((l) =>
    l.href.includes("transaction") || l.href.includes("movement") ||
    l.href.includes("account") || l.href.includes("activity")
  );
  if (movHrefs.length > 0) {
    debugLog.push(`  Navigating to: ${movHrefs[0].href}`);
    await page.goto(movHrefs[0].href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);
  }
  await doSave(page, "08-citi-movements");

  const movements = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];
    const rows = document.querySelectorAll("table tbody tr, .transaction-row, .movement-row");
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td, .cell"));
      if (cells.length < 3) continue;
      const texts = cells.map((c) => (c as HTMLElement).innerText?.trim() || "");
      const datePattern = /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/;
      if (!datePattern.test(texts[0])) continue;
      results.push({ date: texts[0], description: texts[1] || "", amount: texts[texts.length - 1], balance: texts[texts.length - 2] || "0" });
    }
    return results;
  });

  debugLog.push(`  Found ${movements.length} movements`);
  return movements.map((m) => ({
    date: normalizeDate(m.date),
    description: m.description,
    amount: parseChileanAmount(m.amount),
    balance: parseChileanAmount(m.balance),
    source: MOVEMENT_SOURCE.account,
  })).filter((m) => m.amount !== 0);
}

// ─── Main ─────────────────────────────────────────────────────

async function scrapeCiti(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut: username, password, onProgress } = options;
  const { page, browser, debugLog, screenshot } = session;
  const progress = onProgress || (() => {});

  // Set up listener for new tabs BEFORE login (Citi's interstitial opens a new tab)
  const newPagePromise = new Promise<Page>((resolve) => {
    browser.once("targetcreated", async (target) => {
      const newPage = await target.page();
      if (newPage) resolve(newPage);
    });
  });

  progress("Abriendo Citi...");
  const loginResult = await citiLogin(page, username, password, debugLog, screenshot);
  if (!loginResult.success) {
    return { success: false, bank: "citi", movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  // If login landed on interstitial, wait for the new tab it spawns
  let activePage = page;
  if (page.url().includes("interstitial") || page.isClosed()) {
    debugLog.push("  Waiting for new tab from interstitial...");
    try {
      const newPage = await Promise.race([
        newPagePromise,
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000)),
      ]) as Page | null;
      if (newPage) {
        activePage = newPage;
        await delay(4000);
        debugLog.push(`  New tab URL: ${activePage.url()}`);
      }
    } catch {
      // No new tab — maybe it redirected in place
      await delay(3000);
    }
  }

  progress("Extrayendo movimientos...");
  const movements = await extractMovements(activePage, debugLog, screenshot);
  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`6. Total: ${deduplicated.length} movimientos`);
  progress(`Listo — ${deduplicated.length} movimientos`);
  return { success: true, bank: "citi", movements: deduplicated, debug: debugLog.join("\n") };
}

// ─── Export ───────────────────────────────────────────────────

const citi: BankScraper = {
  id: "citi",
  name: "Citibank",
  url: "https://online.citi.com",
  scrape: (options) => runScraper("citi", options, {}, scrapeCiti),
};

export default citi;
