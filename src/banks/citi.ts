import type { Page, Frame } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { delay, parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// Citi uses online.citi.com (global portal — Citibank sold Chilean retail to Scotiabank,
// remaining CL users are redirected here).
const LOGIN_URL = "https://www.citi.com";

// ─── Anti-detection ───────────────────────────────────────────

async function applyStealthPatches(page: Page): Promise<void> {
  // Override navigator.webdriver (headless indicator)
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // Spoof plugins length (0 in headless)
    Object.defineProperty(navigator, "plugins", { get: () => ({ length: 5 }) });
    // Spoof languages
    Object.defineProperty(navigator, "languages", { get: () => ["es-CL", "es", "en-US", "en"] });
  });
}

// ─── Login ────────────────────────────────────────────────────

async function getLoginFrame(page: Page): Promise<Frame | null> {
  await delay(1500);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const hasUser = await frame.$('#username, [name="username"]').catch(() => null);
    if (hasUser) return frame;
  }
  return null;
}

async function waitForIoBlackBox(frame: Frame | Page, timeoutMs = 8000): Promise<void> {
  // ioBlackBox is a hidden field populated by ThreatMetrix/LexisNexis JS.
  // Submitting without it triggers bot detection — wait for it to be set.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await frame.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>('[name="ioBlackBox"], #ioBlackBox, input[id*="blackbox" i]');
      return el?.value ?? "";
    });
    if (val.length > 10) return;
    await delay(300);
  }
  // Proceed anyway — some Citi pages don't use ioBlackBox
}

async function citiLogin(
  page: Page,
  username: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
): Promise<{ success: boolean; error?: string }> {
  await applyStealthPatches(page);

  debugLog.push("1. Navigating to Citi...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait for Angular/ThreatMetrix SDK and ioBlackBox to initialize
  await delay(7000);
  await doSave(page, "01-citi-login");

  debugLog.push("2. Looking for login form...");
  const frame: Frame | Page = await getLoginFrame(page) ?? page;
  debugLog.push(frame !== page ? "  Found login iframe" : "  Using main page");

  // ── Step 1: username ──────────────────────────────────────
  const userSelectors = ["#username", '[name="username"]', 'input[autocomplete="username"]'];
  let userEl = null;
  for (const sel of userSelectors) {
    userEl = await frame.$(sel).catch(() => null);
    if (userEl) { debugLog.push(`  Username field: ${sel}`); break; }
  }
  if (!userEl) {
    await doSave(page, "02-citi-no-user-field");
    return { success: false, error: "No se encontró campo de usuario. Usa --screenshots para diagnosticar." };
  }

  const userPos = await frame.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, userEl);

  await page.mouse.move(userPos.x - 40, userPos.y - 20, { steps: 10 });
  await delay(200);
  await page.mouse.click(userPos.x, userPos.y);
  await delay(500);
  await page.keyboard.type(username, { delay: 100 });
  await delay(600);
  await doSave(page, "03-citi-username-typed");

  // ── Check for 2-step: "Next" button before password ──────
  const nextBtn = await frame.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>("button, [type='submit']"));
    return candidates.find((b) => /next|siguiente|continuar/i.test(b.textContent ?? "")) !== undefined;
  });

  if (nextBtn) {
    debugLog.push("  2-step login: clicking Next");
    const nextPos = await frame.evaluate(() => {
      const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("button, [type='submit']"))
        .find((b) => /next|siguiente|continuar/i.test(b.textContent ?? ""));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (nextPos) {
      const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
      await page.mouse.move(nextPos.x - 10, nextPos.y - 5, { steps: 5 });
      await delay(150);
      await page.mouse.click(nextPos.x, nextPos.y);
      await navPromise;
      await delay(3000);
      await doSave(page, "03b-citi-after-next");
    }
  }

  // ── Step 2: password ──────────────────────────────────────
  const passSelectors = ["#password", '[name="password"]', 'input[type="password"]', 'input[autocomplete="current-password"]'];
  let passEl = null;
  for (const sel of passSelectors) {
    passEl = await frame.$(sel).catch(() => null);
    if (passEl) { debugLog.push(`  Password field: ${sel}`); break; }
  }
  if (!passEl) {
    await doSave(page, "03-citi-no-pass-field");
    return { success: false, error: "No se encontró campo de contraseña." };
  }

  const passPos = await frame.evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, passEl);

  await page.mouse.move(passPos.x - 20, passPos.y, { steps: 8 });
  await page.mouse.click(passPos.x, passPos.y);
  await delay(400);
  await page.keyboard.type(password, { delay: 95 });

  // Wait for ioBlackBox fingerprint to be populated before submitting
  await waitForIoBlackBox(frame);
  await delay(1500);
  await doSave(page, "04-citi-pre-submit");
  debugLog.push("3. Submitting...");

  const btnPos = await frame.evaluate(() => {
    const btn =
      document.querySelector<HTMLButtonElement>("#signInBtn") ||
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => /sign on|sign in|ingresar|entrar/i.test(b.textContent ?? ""),
      );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });

  const navPromise = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
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
  debugLog.push(`  URL after submit: ${page.url()}`);
  await doSave(page, "05-citi-after-login");

  // Check for auth errors
  const errorText = await page.evaluate(() => {
    const errorKw = ["incorrect", "invalid", "wrong", "failed", "incorrecto", "inválido", "no match", "try again"];
    for (const sel of [".error", '[class*="error"]', '[role="alert"]', ".errorMessage", "#errorMsg"]) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const txt = (el as HTMLElement).innerText?.trim();
        if (txt && errorKw.some((kw) => txt.toLowerCase().includes(kw))) return txt;
      }
    }
    return null;
  });
  if (errorText) return { success: false, error: `Error de login: ${errorText}` };

  const url = page.url();
  if (url.includes("citi.com") && !url.includes("login") && !url.includes("signon") && !url.includes("www.citi.com/us")) {
    debugLog.push("4. Login OK!");
    return { success: true };
  }

  await doSave(page, "06-citi-stuck-login");
  return { success: false, error: `Login no completado (URL: ${url}). Usa --screenshots para diagnosticar.` };
}

// ─── Extraction ───────────────────────────────────────────────

async function extractMovements(page: Page, debugLog: string[], doSave: (page: Page, name: string) => Promise<void>): Promise<BankMovement[]> {
  debugLog.push("5. Extracting movements...");
  await delay(5000);
  debugLog.push(`  Dashboard URL: ${page.url()}`);
  await doSave(page, "07-citi-dashboard");

  // Try known Citi transaction download endpoint first (CSV, most reliable)
  const csvUrl = await tryCsvDownload(page, debugLog);
  if (csvUrl.length > 0) return csvUrl;

  // Fall back to DOM scraping
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ text: (a as HTMLElement).innerText?.trim().slice(0, 40), href: (a as HTMLAnchorElement).href }))
      .filter((l) => l.text && l.href)
      .slice(0, 25),
  );
  debugLog.push(`  Links: ${JSON.stringify(links)}`);

  const movHrefs = links.filter((l) =>
    l.href.includes("transaction") || l.href.includes("movement") ||
    l.href.includes("account") || l.href.includes("activity"),
  );
  if (movHrefs.length > 0) {
    debugLog.push(`  Navigating to: ${movHrefs[0].href}`);
    await page.goto(movHrefs[0].href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await delay(3000);
  }
  await doSave(page, "08-citi-movements");

  const movements = await page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: string; balance: string }> = [];
    const rows = document.querySelectorAll("table tbody tr, .transaction-row, .movement-row, [class*='transaction']");
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("td, .cell, [class*='cell']"));
      if (cells.length < 3) continue;
      const texts = cells.map((c) => (c as HTMLElement).innerText?.trim() || "");
      const datePattern = /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/;
      if (!datePattern.test(texts[0])) continue;
      results.push({ date: texts[0], description: texts[1] || "", amount: texts[texts.length - 1], balance: texts[texts.length - 2] || "0" });
    }
    return results;
  });

  debugLog.push(`  Found ${movements.length} movements via DOM`);
  return movements
    .map((m) => ({
      date: normalizeDate(m.date),
      description: m.description,
      amount: parseChileanAmount(m.amount),
      balance: parseChileanAmount(m.balance),
      source: MOVEMENT_SOURCE.account,
    }))
    .filter((m) => m.amount !== 0);
}

async function tryCsvDownload(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  // Citi exposes a REST endpoint for account list and CSV download (documented in bankscrape reference)
  try {
    const accounts = await page.evaluate(async () => {
      const res = await fetch("/US/REST/accountsPanel/getCustomerAccounts.jws", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) return null;
      return res.json();
    });

    if (!accounts) return [];
    debugLog.push(`  REST accounts: ${JSON.stringify(accounts).slice(0, 200)}`);

    // If accounts found, navigate to statement download
    const downloadUrl = `/US/NCSC/dcd/StatementDownload.do`;
    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth() - 3, 1);
    const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

    const csvText = await page.evaluate(async (url: string, fromStr: string, toStr: string) => {
      const params = new URLSearchParams({ fromDate: fromStr, toDate: toStr, downloadType: "CSV" });
      const res = await fetch(`${url}?${params}`, { credentials: "include" });
      if (!res.ok || !res.headers.get("content-type")?.includes("text")) return null;
      return res.text();
    }, downloadUrl, fmt(from), fmt(today));

    if (!csvText) return [];
    debugLog.push("  CSV download succeeded");
    return parseCitiCsv(csvText);
  } catch {
    return [];
  }
}

function parseCitiCsv(csv: string): BankMovement[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  const movements: BankMovement[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 4) continue;
    const date = normalizeDate(cols[0]);
    if (!date) continue;
    const description = cols[1] || cols[2] || "";
    const amount = parseChileanAmount(cols[3] || cols[4] || "0");
    if (amount === 0) continue;
    movements.push({ date, description, amount, balance: 0, source: MOVEMENT_SOURCE.account });
  }
  return movements;
}

// ─── Main ─────────────────────────────────────────────────────

async function scrapeCiti(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut: username, password, onProgress } = options;
  const { page, browser, debugLog, screenshot } = session;
  const progress = onProgress || (() => {});

  // Set up new-tab listener BEFORE login — Citi's interstitial opens a new tab
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

  // Handle interstitial new-tab
  let activePage = page;
  if (page.url().includes("interstitial") || page.isClosed()) {
    debugLog.push("  Waiting for new tab from interstitial...");
    try {
      const newPage = await Promise.race([
        newPagePromise,
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
      ]) as Page | null;
      if (newPage) {
        activePage = newPage;
        await delay(4000);
        debugLog.push(`  New tab URL: ${activePage.url()}`);
      }
    } catch {
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
  url: "https://www.citi.com",
  scrape: (options) => runScraper("citi", options, {}, scrapeCiti),
};

export default citi;
