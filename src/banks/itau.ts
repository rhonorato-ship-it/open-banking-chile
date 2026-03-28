import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, parseChileanAmount, normalizeDate, deduplicateMovements, normalizeInstallments, delay } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";

// ─── Itau constants ──────────────────────────────────────────────
//
// Auth: WPS (IBM WebSphere Portal) form-login at banco.itau.cl
// Data: Server-rendered HTML pages (not JSON APIs)
// Bot protection: Imperva/Incapsula — blocks Node.js fetch() but allows real browsers
//
// Browser mode required — there are NO JSON API endpoints. All data
// is embedded in server-rendered HTML (IBM WebSphere Portal).

const LOGIN_URL = "https://banco.itau.cl/wps/portal/newolb/web/login";
const PORTAL_BASE = "https://banco.itau.cl/wps/myportal/newolb/web";

const TWO_FACTOR_KEYWORDS = ["itaú key", "itau key", "aprueba", "segundo factor", "autoriza"];
const REJECTION_KEYWORDS = ["rechazad", "denegad", "cancelad"];

// ─── Login ───────────────────────────────────────────────────────

async function itauLogin(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<{ success: true } | { success: false; error: string }> {
  const { page, debugLog, screenshot: doSave } = session;
  const { rut, password, onProgress, onTwoFactorCode } = options;
  const progress = onProgress || (() => {});

  // Step 1: Navigate to login page
  debugLog.push("1. Navigating to login page...");
  progress("Abriendo portal Itau...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await delay(2000);
  await doSave(page, "itau-01-login-page");

  // Check for Imperva block
  const pageText = await page.evaluate(() => document.body?.innerText || "");
  if (pageText.includes("No pudimos validar tu acceso") || pageText.includes("Please stand by")) {
    return {
      success: false,
      error: "Itau bloqueo el acceso (Imperva). Usa --headful --profile para Chrome con perfil real.",
    };
  }

  debugLog.push(`  Current URL: ${page.url()}`);

  // Step 2: Wait for RUT field and enter credentials
  debugLog.push("2. Entering credentials...");
  progress("Ingresando credenciales...");

  try {
    await page.waitForSelector("#loginNameID", { timeout: 15_000 });
  } catch {
    await doSave(page, "itau-02-no-rut-field");
    return {
      success: false,
      error: "No se encontro el campo de RUT (#loginNameID). La pagina puede haber cambiado.",
    };
  }

  // Type formatted RUT with dots and dash (e.g. "17.599.449-1")
  const formattedRut = formatRut(rut);
  debugLog.push(`  Typing RUT: ${formattedRut.slice(0, 4)}...`);
  await page.type("#loginNameID", formattedRut, { delay: 80 });
  await delay(500);

  // Step 3: Enter password
  try {
    await page.waitForSelector("#pswdId", { timeout: 5_000 });
  } catch {
    await doSave(page, "itau-03-no-password-field");
    return {
      success: false,
      error: "No se encontro el campo de clave (#pswdId).",
    };
  }

  await page.type("#pswdId", password, { delay: 80 });
  await delay(500);
  await doSave(page, "itau-03-credentials-filled");

  // Step 4: Click the login button
  debugLog.push("3. Clicking Ingresar...");
  progress("Autenticando...");

  // Try the reCAPTCHA v3 button first, then fall back to a generic "Ingresar" button
  const loginClicked = await page.evaluate(() => {
    // Primary: reCAPTCHA v3 login button
    const recaptchaBtn = document.querySelector("#btnLoginRecaptchaV3") as HTMLElement | null;
    if (recaptchaBtn && !recaptchaBtn.hasAttribute("disabled")) {
      recaptchaBtn.click();
      return "recaptcha-btn";
    }

    // Fallback: any button containing "Ingresar"
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], a.btn"));
    for (const btn of buttons) {
      const text = (btn as HTMLElement).innerText?.trim().toLowerCase() || "";
      const value = (btn as HTMLInputElement).value?.toLowerCase() || "";
      if (text.includes("ingresar") || value.includes("ingresar")) {
        (btn as HTMLElement).click();
        return "ingresar-btn";
      }
    }

    return null;
  });

  if (!loginClicked) {
    // Last resort: press Enter
    await page.keyboard.press("Enter");
    debugLog.push("  Pressed Enter (no button found)");
  } else {
    debugLog.push(`  Clicked: ${loginClicked}`);
  }

  // Step 5: Wait for navigation after login
  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 });
  } catch {
    // Navigation might have already happened or be in progress
    await delay(5000);
  }
  await doSave(page, "itau-04-after-login");

  const postLoginUrl = page.url();
  const postLoginText = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
  debugLog.push(`  Post-login URL: ${postLoginUrl}`);

  // Check for Imperva block after login
  if (postLoginText.includes("no pudimos validar tu acceso") || postLoginText.includes("please stand by")) {
    return {
      success: false,
      error: "Itau bloqueo el acceso (Imperva). Usa --headful --profile para Chrome con perfil real.",
    };
  }

  // Check for login errors
  if (
    postLoginText.includes("incorrecto") ||
    postLoginText.includes("bloqueada") ||
    postLoginText.includes("suspendida") ||
    postLoginText.includes("invalido") ||
    postLoginText.includes("inválido")
  ) {
    const errorMsg = await page.evaluate(() => {
      const errorEls = document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"]');
      for (const el of errorEls) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text && text.length > 3 && text.length < 300) return text;
      }
      return null;
    });
    return {
      success: false,
      error: `Error de login: ${errorMsg || "Credenciales incorrectas (RUT o clave invalida)."}`,
    };
  }

  // Check if still on login page (silent failure)
  if (postLoginText.includes("loginnameid") && postLoginText.includes("pswdid")) {
    return { success: false, error: "Credenciales incorrectas (RUT o clave invalida)." };
  }

  // Step 6: Detect 2FA (Itau Key push notification)
  if (TWO_FACTOR_KEYWORDS.some(kw => postLoginText.includes(kw))) {
    debugLog.push("4. 2FA detected (Itau Key), waiting for approval...");
    progress("Esperando aprobacion de Itau Key...");
    await doSave(page, "itau-05-2fa-detected");

    const timeoutSec = Math.min(600, Math.max(30, parseInt(process.env.ITAU_2FA_TIMEOUT_SEC || "180", 10) || 180));

    // If onTwoFactorCode is available, use it (for web app SSE flow)
    // Itau Key is push-only (no code entry), so we use onTwoFactorCode as a signal
    // that the user has approved on their phone
    if (onTwoFactorCode) {
      debugLog.push("  Waiting for 2FA callback...");
      try {
        await onTwoFactorCode();
        debugLog.push("  2FA callback returned, checking portal...");
      } catch {
        return { success: false, error: "Se requiere Itau Key. Por favor confirma la operacion en tu app antes de sincronizar." };
      }
    }

    // Poll for 2FA completion by checking if the page has changed
    const start = Date.now();
    let approved = false;

    while ((Date.now() - start) / 1000 < timeoutSec) {
      await delay(3000);

      const currentText = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());

      // 2FA rejected
      if (REJECTION_KEYWORDS.some(kw => currentText.includes(kw))) {
        debugLog.push("  2FA rejected.");
        return { success: false, error: "2FA rechazado (Itau Key)." };
      }

      // 2FA no longer showing = approved (page changed)
      if (!TWO_FACTOR_KEYWORDS.some(kw => currentText.includes(kw))) {
        debugLog.push("  2FA approved!");
        approved = true;
        break;
      }

      // Check if URL changed (navigation happened)
      const currentUrl = page.url();
      if (currentUrl !== postLoginUrl && !currentUrl.includes("login")) {
        debugLog.push(`  2FA approved (URL changed to ${currentUrl})`);
        approved = true;
        break;
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 15 === 0) {
        debugLog.push(`  Still waiting for 2FA approval... (${elapsed}s)`);
      }
    }

    if (!approved) {
      return {
        success: false,
        error: "Se requiere Itau Key. Por favor confirma la operacion en tu app antes de sincronizar.",
      };
    }

    await doSave(page, "itau-06-after-2fa");
  }

  debugLog.push("5. Login OK!");
  return { success: true };
}

// ─── Balance extraction ──────────────────────────────────────────

async function extractBalance(session: BrowserSession): Promise<number | undefined> {
  const { page, debugLog, screenshot: doSave } = session;
  debugLog.push("6. Extracting balance...");

  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`, {
    waitUntil: "networkidle2",
    timeout: 30_000,
  });
  await delay(2000);
  await doSave(page, "itau-10-balance-page");

  const balance = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const match = text.match(/Saldo disponible para uso\s*\$?\s*([\d.,]+)/);
    if (match) {
      return parseInt(match[1].replace(/[^0-9]/g, ""), 10);
    }
    return null;
  });

  if (balance !== null && balance !== undefined) {
    debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
    return balance;
  }

  debugLog.push("  Balance not found in page");
  return undefined;
}

// ─── Account movements extraction ────────────────────────────────

async function extractMovements(session: BrowserSession): Promise<BankMovement[]> {
  const { page, debugLog, screenshot: doSave } = session;
  debugLog.push("7. Extracting account movements...");
  const allMovements: BankMovement[] = [];

  await page.goto(`${PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`, {
    waitUntil: "networkidle2",
    timeout: 30_000,
  });
  await delay(2000);
  await doSave(page, "itau-11-movements-page");

  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    // Extract movements from the current page using DOM parsing
    const pageMovements = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr, .table-movimientos tr, .row-movimiento"));
      const results: Array<{ date: string; desc: string; cargo: string; abono: string; saldo: string }> = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td"));
        if (cells.length < 5) continue;

        const cellTexts = cells.map(c => (c as HTMLElement).innerText?.trim() || "");

        // Expect: Fecha, Movimientos/Descripcion, Cargos, Abonos, Saldo (5 or 6 columns)
        const dateText = cellTexts[0];
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateText)) continue;

        results.push({
          date: dateText,
          desc: cellTexts[1],
          cargo: cellTexts[2],
          abono: cellTexts[3],
          saldo: cellTexts[4],
        });
      }
      return results;
    });

    debugLog.push(`  Page ${pageNum}: ${pageMovements.length} movements`);

    for (const m of pageMovements) {
      const cargoVal = parseChileanAmount(m.cargo);
      const abonoVal = parseChileanAmount(m.abono);
      const saldoVal = parseChileanAmount(m.saldo);
      const amount = abonoVal > 0 ? abonoVal : -cargoVal;
      if (amount === 0) continue;

      allMovements.push({
        date: normalizeDate(m.date),
        description: m.desc,
        amount,
        balance: saldoVal,
        source: MOVEMENT_SOURCE.account,
      });
    }

    // Check for pagination: "Pagina X de Y"
    const paginationInfo = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const match = text.match(/P[aá]gina\s+(\d+)\s+de\s+(\d+)/i);
      if (match) return { current: parseInt(match[1], 10), total: parseInt(match[2], 10) };
      return null;
    });

    if (paginationInfo && paginationInfo.current >= paginationInfo.total) break;

    // Click next page button
    const hasNext = await page.evaluate(() => {
      // Look for next button by name attribute or text
      const nextBtn = document.querySelector('a[name="nextbtn"], button[name="nextbtn"]') as HTMLElement | null;
      if (nextBtn) {
        nextBtn.click();
        return true;
      }

      // Fallback: look for "Siguiente" or ">" text
      const links = Array.from(document.querySelectorAll("a, button"));
      for (const link of links) {
        const text = (link as HTMLElement).innerText?.trim().toLowerCase() || "";
        if (text === "siguiente" || text === ">" || text === ">>") {
          (link as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    if (!hasNext) break;

    // Wait for page reload (WPS does full page reloads)
    try {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15_000 });
    } catch {
      await delay(3000);
    }
    await delay(1000);
  }

  debugLog.push(`  Total account movements: ${allMovements.length}`);
  return allMovements;
}

// ─── Credit card extraction ──────────────────────────────────────

async function extractCreditCardData(session: BrowserSession): Promise<{
  movements: BankMovement[];
  creditCards: CreditCardBalance[];
}> {
  const { page, debugLog, screenshot: doSave } = session;
  debugLog.push("8. Extracting credit card data...");
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  // Navigate to credit card summary (deuda) page
  try {
    await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/deuda`, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });
  } catch {
    debugLog.push("  Could not navigate to credit card page");
    return { movements, creditCards };
  }
  await delay(2000);
  await doSave(page, "itau-20-cc-deuda");

  // Extract card info and unbilled movements from deuda page
  const ccData = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const html = document.body?.innerHTML || "";

    // Extract card label
    const cardMatch = text.match(/(Mastercard|Visa)\s+[\w\s]+\*{4}\s*\*{4}\s*\*{4}\s*(\d{4})/i);
    const cardLabel = cardMatch
      ? cardMatch[0].replace(/\*{4}\s*\*{4}\s*\*{4}\s*/, "****").replace(/\s+/g, " ").trim()
      : null;

    // Extract national cupo
    const nacSection = text.match(/Nacional[\s\S]*?(?=Internacional|Ofertas|Movimientos|$)/)?.[0] || "";
    const nacDisponible = nacSection.match(/Cupo disponible\s*\$\s*([\d.]+)/);
    const nacUtilizado = nacSection.match(/Cupo utilizado[\s\S]*?\$\s*([\d.]+)/);

    // Extract international cupo
    const intSection = text.match(/Internacional[\s\S]*?(?=Ofertas|Movimientos|Emergencias|$)/)?.[0] || "";
    const intUsdValues = [...intSection.matchAll(/USD\$?\s*(-?[\d.,]+)/g)].map(m => m[1]);

    // Next billing date
    const proxFactMatch = text.match(/Pr[oó]xima facturaci[oó]n\s*(\d{2}\/\d{2}\/\d{4})/);

    // Extract no-facturados from tables
    const noFactMovements: Array<{ date: string; desc: string; amount: string }> = [];
    // Find tables preceded by "no facturad" text
    const noFactRegex = /no\s*facturad/i;
    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      // Check if this table or its preceding content mentions "no facturad"
      const prevText = table.previousElementSibling?.textContent || "";
      const parentText = table.closest("section, div")?.textContent?.slice(0, 200) || "";
      if (!noFactRegex.test(prevText) && !noFactRegex.test(parentText) && !noFactRegex.test(html.slice(0, html.indexOf(table.outerHTML)).slice(-500))) continue;

      const rows = Array.from(table.querySelectorAll("tr"));
      for (const row of rows) {
        if (row.querySelector("th")) continue;
        const cells = Array.from(row.querySelectorAll("td")).map(c => (c as HTMLElement).innerText?.trim() || "");
        if (cells.length >= 3) {
          noFactMovements.push({
            date: cells[0],
            desc: cells[1],
            amount: cells[cells.length - 1],
          });
        }
      }
    }

    return {
      cardLabel,
      nacDisponible: nacDisponible?.[1] || "0",
      nacUtilizado: nacUtilizado?.[1] || "0",
      intUsdValues,
      proxFactDate: proxFactMatch?.[1] || null,
      noFactMovements,
    };
  });

  if (!ccData.cardLabel) {
    debugLog.push("  No credit card found");
    return { movements, creditCards };
  }

  debugLog.push(`  Card: ${ccData.cardLabel}`);

  // Build credit card balance
  const nacUsed = parseChileanAmount(ccData.nacUtilizado);
  const nacAvailable = parseChileanAmount(ccData.nacDisponible);

  const card: CreditCardBalance = {
    label: ccData.cardLabel,
    national: { used: nacUsed, available: nacAvailable, total: nacUsed + nacAvailable },
  };

  // International cupo
  if (ccData.intUsdValues.length >= 3) {
    const parseUsd = (s: string) => parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0;
    card.international = {
      used: Math.abs(parseUsd(ccData.intUsdValues[1] || "0")),
      available: parseUsd(ccData.intUsdValues[2] || "0"),
      total: parseUsd(ccData.intUsdValues[0] || "0"),
      currency: "USD",
    };
  }

  if (ccData.proxFactDate) card.nextBillingDate = normalizeDate(ccData.proxFactDate);

  creditCards.push(card);

  // Process no-facturados
  let noFactCount = 0;
  for (const m of ccData.noFactMovements) {
    const amount = parseChileanAmount(m.amount);
    if (amount === 0) continue;
    movements.push({
      date: normalizeDate(m.date),
      description: m.desc,
      amount: -amount,
      balance: 0,
      source: MOVEMENT_SOURCE.credit_card_unbilled,
    });
    noFactCount++;
  }
  debugLog.push(`  No-facturados: ${noFactCount}`);

  // Navigate to billed movements (cuenta-nacional)
  try {
    await page.goto(`${PORTAL_BASE}/tarjeta-credito/resumen/cuenta-nacional`, {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });
    await delay(2000);
    await doSave(page, "itau-21-cc-facturados");

    const billedMovements = await page.evaluate(() => {
      const results: Array<{ date: string; desc: string; amount: string; cuota: string }> = [];
      const rows = Array.from(document.querySelectorAll("table tr"));

      for (const row of rows) {
        if (row.querySelector("th")) continue;
        const cells = Array.from(row.querySelectorAll("td")).map(c => (c as HTMLElement).innerText?.trim() || "");
        if (cells.length < 7) continue;

        // cells[1] = date, cells[3] = description, cells[4] = amount, cells[6] = cuota
        const dateText = cells[1];
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateText)) continue;

        results.push({
          date: dateText,
          desc: cells[3],
          amount: cells[4],
          cuota: cells[6],
        });
      }
      return results;
    });

    let factCount = 0;
    for (const m of billedMovements) {
      const amount = parseChileanAmount(m.amount);
      if (amount === 0) continue;

      movements.push({
        date: normalizeDate(m.date),
        description: m.desc,
        amount: amount > 0 ? -amount : Math.abs(amount),
        balance: 0,
        source: MOVEMENT_SOURCE.credit_card_billed,
        installments: normalizeInstallments(m.cuota),
      });
      factCount++;
    }
    debugLog.push(`  Facturados: ${factCount}`);
  } catch (err) {
    debugLog.push(`  Error fetching billed movements: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeItau(
  session: BrowserSession,
  options: ScraperOptions,
): Promise<ScrapeResult> {
  const { debugLog } = session;
  const bank = "itau";
  const progress = options.onProgress || (() => {});

  // Login
  progress("Conectando con Itau...");
  const loginResult = await itauLogin(session, options);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }
  progress("Sesion iniciada correctamente");

  // Extract balance
  progress("Extrayendo saldo...");
  const balance = await extractBalance(session);

  // Extract account movements
  progress("Extrayendo movimientos de cuenta...");
  const accountMovements = await extractMovements(session);
  progress(`Cuenta: ${accountMovements.length} movimientos`);

  // Extract credit card data
  progress("Extrayendo datos de tarjeta de credito...");
  let tcResult: { movements: BankMovement[]; creditCards: CreditCardBalance[] };
  try {
    tcResult = await extractCreditCardData(session);
  } catch (err) {
    debugLog.push(`  TC error: ${err instanceof Error ? err.message : String(err)}`);
    tcResult = { movements: [], creditCards: [] };
  }

  const deduplicated = deduplicateMovements([...accountMovements, ...tcResult.movements]);
  debugLog.push(`9. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance,
    creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const itau: BankScraper = {
  id: "itau",
  name: "Itau",
  url: "https://banco.itau.cl",
  // No mode: "api" — this is browser mode (default) because
  // Itau's portal is fully server-rendered (IBM WebSphere Portal)
  // with no JSON API endpoints. Imperva blocks Node.js fetch().
  scrape: (options) => runScraper("itau", options, {}, scrapeItau),
};

export default itau;
