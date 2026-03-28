import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, parseChileanAmount, deduplicateMovements, normalizeInstallments } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── BCI constants ──────────────────────────────────────────────
//
// Auth: JSF form-login at www.bci.cl with javax.faces.ViewState
// Data: Server-rendered HTML via JSF iframe URLs (not JSON APIs)
// 2FA: BCI Pass push notification (poll for page change)
//
// No browser needed — this scraper uses fetch() with HTML parsing.

const LOGIN_URL = "https://www.bci.cl/corporativo/banco-en-linea/personas";
const PORTAL_BASE = "https://www.bci.cl";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TWO_FACTOR_KEYWORDS = ["bci pass", "segundo factor", "aprobacion en tu app", "autorizar en tu app", "confirmar en tu app", "aprobación en tu app"];
const TWO_FACTOR_REJECTION = ["rechazad", "denegad", "cancelad"];

// JSF iframe URL patterns for data extraction
const IFRAME_PATTERNS = {
  content: ["miBanco.jsf", "vistaSupercartola"],
  movements: "fe-saldosultimosmov",
  tcMovements: "fe-mismovimientos",
  tcCupo: "vistaSaldosTDC.jsf",
} as const;

// TC tab/billing combinations to scrape
const TC_COMBINATIONS: Array<{ tab: string; billingType: string; source: MovementSource }> = [
  { tab: "Nacional $", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Nacional $", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
  { tab: "Internacional USD", billingType: "No facturados", source: MOVEMENT_SOURCE.credit_card_unbilled },
  { tab: "Internacional USD", billingType: "Facturados", source: MOVEMENT_SOURCE.credit_card_billed },
];

// ─── Cookie jar ─────────────────────────────────────────────────

interface CookieJar {
  cookies: Map<string, string>;
  set(raw: string): void;
  setAll(headers: Headers): void;
  header(): string;
}

function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    cookies,
    set(raw: string) {
      const [nameValue] = raw.split(";");
      const eqIdx = nameValue.indexOf("=");
      if (eqIdx > 0) cookies.set(nameValue.slice(0, eqIdx).trim(), nameValue.slice(eqIdx + 1).trim());
    },
    setAll(headers: Headers) {
      const setCookies = headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) this.set(raw);
    },
    header() {
      return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

// ─── HTML parsing helpers ───────────────────────────────────────

/** Extract javax.faces.ViewState from HTML */
function extractViewState(html: string): string | null {
  const match = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
  if (match) return match[1];
  // Try alternate format
  const alt = html.match(/id="javax\.faces\.ViewState(?::?\d*)?"[^>]*value="([^"]*)"/);
  return alt ? alt[1] : null;
}

/** Extract iframe src URLs from HTML */
function extractIframeSrcs(html: string): string[] {
  const srcs: string[] = [];
  const regex = /<iframe[^>]+src="([^"]+)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    srcs.push(m[1]);
  }
  return srcs;
}

/** Extract table rows from HTML (each row = array of cell texts) */
function extractTableRows(html: string): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      // Strip HTML tags and trim
      cells.push(cellMatch[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** Extract select options from HTML */
function extractSelectOptions(html: string, selectPattern: string): Array<{ value: string; label: string }> {
  const selectRegex = new RegExp(`<select[^>]*${selectPattern}[^>]*>([\\s\\S]*?)<\\/select>`, "i");
  const selectMatch = html.match(selectRegex);
  if (!selectMatch) return [];

  const options: Array<{ value: string; label: string }> = [];
  const optRegex = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optRegex.exec(selectMatch[1])) !== null) {
    const label = m[2].replace(/<[^>]*>/g, "").trim();
    if (label && m[1]) options.push({ value: m[1], label });
  }
  return options;
}

/** Strip HTML tags and decode common entities */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Fetch helpers ──────────────────────────────────────────────

async function fetchGet(jar: CookieJar, url: string, redirect: RequestRedirect = "follow"): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Cookie: jar.header(),
      Referer: LOGIN_URL,
    },
    redirect,
  });
  jar.setAll(res.headers);
  return res;
}

async function fetchPost(jar: CookieJar, url: string, body: URLSearchParams, redirect: RequestRedirect = "manual"): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Cookie: jar.header(),
      Referer: LOGIN_URL,
    },
    body: body.toString(),
    redirect,
  });
  jar.setAll(res.headers);
  return res;
}

async function fetchHtml(jar: CookieJar, url: string): Promise<string> {
  const res = await fetchGet(jar, url);
  return res.text();
}

/** Follow a chain of redirects, collecting cookies at each step */
async function followRedirects(jar: CookieJar, url: string, maxRedirects = 10): Promise<{ finalUrl: string; html: string }> {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetchGet(jar, currentUrl, "manual");
    const location = res.headers.get("location");
    if (location && (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307)) {
      currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).href;
      // Consume body to avoid connection issues
      await res.text();
      continue;
    }
    const html = await res.text();
    return { finalUrl: currentUrl, html };
  }
  // Final attempt
  const html = await fetchHtml(jar, currentUrl);
  return { finalUrl: currentUrl, html };
}

// ─── Login ──────────────────────────────────────────────────────

async function bciLogin(
  rut: string,
  password: string,
  debugLog: string[],
): Promise<{ success: true; jar: CookieJar; portalHtml: string } | { success: false; error: string }> {
  const jar = createCookieJar();

  // Step 1: GET login page for cookies and ViewState
  debugLog.push("1. Fetching BCI login page...");
  const loginPageRes = await fetchGet(jar, LOGIN_URL);
  const loginPageHtml = await loginPageRes.text();
  debugLog.push(`  Status: ${loginPageRes.status}, cookies: ${jar.cookies.size}`);

  const viewState = extractViewState(loginPageHtml);
  if (!viewState) {
    debugLog.push("  WARNING: No ViewState found, proceeding anyway...");
  }
  debugLog.push(`  ViewState: ${viewState ? viewState.substring(0, 30) + "..." : "not found"}`);

  // Step 2: Parse RUT fields
  const cleanRut = rut.replace(/[.\-\s]/g, "");
  const rutBody = cleanRut.slice(0, -1); // digits only, no check digit
  const rutDv = cleanRut.slice(-1);       // check digit only
  const rutFormatted = formatRut(rut);     // formatted for rut_aux

  // Step 3: POST login form
  debugLog.push("2. Submitting credentials...");
  const formData = new URLSearchParams();
  formData.set("rut_aux", rutFormatted);
  formData.set("rut", rutBody);
  formData.set("dig", rutDv);
  formData.set("clave", password);
  if (viewState) formData.set("javax.faces.ViewState", viewState);

  // Look for a form action URL in the HTML
  const formAction = loginPageHtml.match(/<form[^>]*id="frm"[^>]*action="([^"]*)"/i);
  const loginPostUrl = formAction ? new URL(formAction[1].replace(/&amp;/g, "&"), LOGIN_URL).href : LOGIN_URL;

  const loginRes = await fetchPost(jar, loginPostUrl, formData);
  const location = loginRes.headers.get("location") || "";
  debugLog.push(`  Login response: ${loginRes.status}, Location: ${location}`);

  // Step 4: Follow redirects to portal
  let portalHtml: string;
  if (loginRes.status >= 300 && loginRes.status < 400 && location) {
    debugLog.push("3. Following redirect chain...");
    await loginRes.text(); // consume body
    const redirectUrl = location.startsWith("http") ? location : new URL(location, loginPostUrl).href;
    const result = await followRedirects(jar, redirectUrl);
    portalHtml = result.html;
    debugLog.push(`  Final URL: ${result.finalUrl}`);
  } else {
    portalHtml = await loginRes.text();
  }

  // Check for login failure
  const portalTextLower = stripHtml(portalHtml).toLowerCase();
  if (portalTextLower.includes("clave incorrecta") || portalTextLower.includes("datos incorrectos") || portalTextLower.includes("no se pudo validar")) {
    return { success: false, error: "Credenciales incorrectas (RUT o clave inv\u00e1lida)." };
  }

  // Check if we're still on the login page
  if (portalHtml.includes('id="frm"') && portalHtml.includes('id="clave"') && !portalHtml.includes("miBanco")) {
    return { success: false, error: "Login no naveg\u00f3 fuera de la p\u00e1gina de login." };
  }

  // Step 5: Handle 2FA (BCI Pass push)
  if (TWO_FACTOR_KEYWORDS.some(kw => portalTextLower.includes(kw))) {
    debugLog.push("3b. 2FA detected (BCI Pass). Waiting for approval...");
    const envValue = process.env.BCI_2FA_TIMEOUT_SEC;
    const timeoutSec = Math.min(600, Math.max(30, parseInt(envValue || "180", 10) || 180));
    debugLog.push(`  Timeout: ${timeoutSec}s`);

    const start = Date.now();
    let approved = false;
    while ((Date.now() - start) / 1000 < timeoutSec) {
      await new Promise(r => setTimeout(r, 2000));

      // Re-fetch the current page to check if 2FA was approved
      const checkHtml = await fetchHtml(jar, loginPostUrl);
      const checkText = stripHtml(checkHtml).toLowerCase();

      // Check for rejection
      if (TWO_FACTOR_REJECTION.some(kw => checkText.includes(kw))) {
        debugLog.push("  2FA rechazado por el usuario.");
        return { success: false, error: "2FA rechazado." };
      }

      // Check if 2FA keywords are gone (approved)
      if (!TWO_FACTOR_KEYWORDS.some(kw => checkText.includes(kw))) {
        debugLog.push("  2FA completed, continuing...");
        portalHtml = checkHtml;
        approved = true;
        break;
      }
    }

    if (!approved) {
      return { success: false, error: `Timeout esperando BCI Pass (${timeoutSec}s).` };
    }
  }

  debugLog.push(`4. Login OK! Cookies: ${Array.from(jar.cookies.keys()).join(", ")}`);
  return { success: true, jar, portalHtml };
}

// ─── Data extraction ────────────────────────────────────────────

function parseAccountMovementsFromHtml(html: string): BankMovement[] {
  const movements: BankMovement[] = [];
  const rows = extractTableRows(html);

  for (const cells of rows) {
    if (cells.length < 4) continue;
    const dateStr = cells[0];
    // Validate date format: dd/mm/yyyy or dd/mm/yy
    if (!/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(dateStr)) continue;

    const description = cells[1];
    const cargoAmount = cells[2] ? parseChileanAmount(cells[2]) : 0;
    const abonoAmount = cells[3] ? parseChileanAmount(cells[3]) : 0;
    const amount = cargoAmount > 0 ? -cargoAmount : abonoAmount;
    if (amount === 0) continue;

    movements.push({
      date: normalizeDate(dateStr),
      description,
      amount,
      balance: 0,
      source: MOVEMENT_SOURCE.account,
    });
  }
  return movements;
}

function parseTCMovementsFromHtml(html: string, source: MovementSource): BankMovement[] {
  const movements: BankMovement[] = [];
  const rows = extractTableRows(html);

  for (const cells of rows) {
    if (cells.length < 2) continue;
    const dateStr = cells[0];
    if (!dateStr || !/\d{1,2}[\/.\-\s]/.test(dateStr)) continue;

    const description = cells[1];
    const amountStr = cells[cells.length - 1] || cells[2] || "";
    const numStr = amountStr.replace(/[^0-9.\-,]/g, "");
    const amount = parseFloat(numStr.replace(/\./g, "").replace(",", ".")) || 0;
    if (amount === 0) continue;

    movements.push({
      date: normalizeDate(dateStr),
      description,
      amount: -Math.abs(amount),
      balance: 0,
      source,
      installments: cells.length >= 4 ? normalizeInstallments(cells[3]) : undefined,
    });
  }
  return movements;
}

function parseCupoFromHtml(html: string): {
  nationalUsed: number; nationalAvailable: number; nationalTotal: number;
  internationalUsed: number; internationalAvailable: number; internationalTotal: number;
} {
  const text = stripHtml(html);
  const parseAmt = (t: string) => parseInt(t.replace(/[^0-9]/g, ""), 10) || 0;

  const natUsed = text.match(/utilizado\s*(?:nacional)?\s*\$?\s*([\d.]+)/i);
  const natAvail = text.match(/disponible\s*(?:nacional)?\s*\$?\s*([\d.]+)/i);
  const natTotal = text.match(/total\s*(?:nacional)?\s*\$?\s*([\d.]+)/i);
  const intUsed = text.match(/utilizado\s*(?:internacional)?\s*USD?\s*\$?\s*([\d.,]+)/i);
  const intAvail = text.match(/disponible\s*(?:internacional)?\s*USD?\s*\$?\s*([\d.,]+)/i);
  const intTotal = text.match(/total\s*(?:internacional)?\s*USD?\s*\$?\s*([\d.,]+)/i);

  return {
    nationalUsed: natUsed ? parseAmt(natUsed[1]) : 0,
    nationalAvailable: natAvail ? parseAmt(natAvail[1]) : 0,
    nationalTotal: natTotal ? parseAmt(natTotal[1]) : 0,
    internationalUsed: intUsed ? parseAmt(intUsed[1]) : 0,
    internationalAvailable: intAvail ? parseAmt(intAvail[1]) : 0,
    internationalTotal: intTotal ? parseAmt(intTotal[1]) : 0,
  };
}

/** Extract balance from HTML page text */
function parseBalanceFromHtml(html: string): number | undefined {
  const text = stripHtml(html);
  // Look for patterns like "Saldo disponible $1.234.567" or "Saldo $1.234.567"
  const match = text.match(/saldo\s*(?:disponible)?\s*\$\s*([\d.]+)/i);
  if (match) return parseInt(match[1].replace(/\./g, ""), 10) || undefined;
  return undefined;
}

/** Find an iframe URL matching a pattern in a list of iframe srcs */
function findIframeUrl(iframeSrcs: string[], pattern: string | readonly string[]): string | undefined {
  const patterns = Array.isArray(pattern) ? pattern : [pattern as string];
  for (const src of iframeSrcs) {
    if (patterns.some(p => src.includes(p))) return src;
  }
  return undefined;
}

/** Resolve a possibly-relative URL against a base */
function resolveUrl(base: string, url: string): string {
  if (url.startsWith("http")) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return `${PORTAL_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
  }
}

// ─── Account movements ─────────────────────────────────────────

async function fetchAccountMovements(
  jar: CookieJar,
  portalHtml: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; balance?: number }> {
  const movements: BankMovement[] = [];
  let balance: number | undefined;

  // Find the movements iframe URL
  const iframeSrcs = extractIframeSrcs(portalHtml);
  debugLog.push(`  Found ${iframeSrcs.length} iframes in portal`);

  const movUrl = findIframeUrl(iframeSrcs, IFRAME_PATTERNS.movements);
  if (!movUrl) {
    // Try to find content iframe first, then look for movements inside it
    const contentUrl = findIframeUrl(iframeSrcs, IFRAME_PATTERNS.content);
    if (contentUrl) {
      debugLog.push(`  Loading content iframe: ${contentUrl}`);
      const contentHtml = await fetchHtml(jar, resolveUrl(PORTAL_BASE, contentUrl));
      const innerIframes = extractIframeSrcs(contentHtml);
      const innerMovUrl = findIframeUrl(innerIframes, IFRAME_PATTERNS.movements);
      if (innerMovUrl) {
        return fetchMovementsFromUrl(jar, resolveUrl(PORTAL_BASE, innerMovUrl), debugLog);
      }
      // Try extracting movements from the content page itself
      balance = parseBalanceFromHtml(contentHtml);
      const directMovs = parseAccountMovementsFromHtml(contentHtml);
      if (directMovs.length > 0) {
        debugLog.push(`  Found ${directMovs.length} movements directly in content`);
        return { movements: directMovs, balance };
      }
    }
    debugLog.push("  No movements iframe found");
    return { movements, balance };
  }

  return fetchMovementsFromUrl(jar, resolveUrl(PORTAL_BASE, movUrl), debugLog);
}

async function fetchMovementsFromUrl(
  jar: CookieJar,
  movUrl: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; balance?: number }> {
  const movements: BankMovement[] = [];
  debugLog.push(`  Loading movements page: ${movUrl}`);
  const movHtml = await fetchHtml(jar, movUrl);

  // Extract balance
  const balance = parseBalanceFromHtml(movHtml);

  // Check for account selector (multi-account)
  const accounts = extractSelectOptions(movHtml, "cuenta|select");

  if (accounts.length > 1) {
    debugLog.push(`  Found ${accounts.length} accounts`);
    for (const acct of accounts) {
      debugLog.push(`    Fetching account: ${acct.label}`);
      // For each account, try to fetch by adding account parameter to URL
      const acctUrl = movUrl.includes("?")
        ? `${movUrl}&cuenta=${encodeURIComponent(acct.value)}`
        : `${movUrl}?cuenta=${encodeURIComponent(acct.value)}`;
      try {
        const acctHtml = await fetchHtml(jar, acctUrl);
        const acctMovs = parseAccountMovementsFromHtml(acctHtml);
        const prefixed = accounts.length > 1
          ? acctMovs.map(m => ({ ...m, description: `[${acct.label}] ${m.description}`.trim() }))
          : acctMovs;
        movements.push(...prefixed);
        debugLog.push(`      ${acctMovs.length} movements`);
      } catch (err) {
        debugLog.push(`      Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    // Single account or no selector
    const movs = parseAccountMovementsFromHtml(movHtml);
    movements.push(...movs);
    debugLog.push(`  ${movs.length} movements from page`);
  }

  return { movements, balance };
}

// ─── Credit card data ───────────────────────────────────────────

async function fetchCreditCardData(
  jar: CookieJar,
  portalHtml: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  const iframeSrcs = extractIframeSrcs(portalHtml);

  // TC movements
  const tcMovUrl = findIframeUrl(iframeSrcs, IFRAME_PATTERNS.tcMovements);
  if (tcMovUrl) {
    debugLog.push(`  Loading TC movements iframe: ${tcMovUrl}`);
    try {
      const tcHtml = await fetchHtml(jar, resolveUrl(PORTAL_BASE, tcMovUrl));

      // For each combination, the JSF page may render different data based on ViewState POSTs.
      // In API mode without JS execution, we can only parse what the initial GET returns.
      // We try to extract all visible movements from the page.
      for (const combo of TC_COMBINATIONS) {
        const comboMovs = parseTCMovementsFromHtml(tcHtml, combo.source);
        if (comboMovs.length > 0) {
          movements.push(...comboMovs);
          debugLog.push(`    ${combo.tab} / ${combo.billingType}: ${comboMovs.length} movements`);
        }
      }

      // If no combo-specific extraction worked, try generic extraction
      if (movements.length === 0) {
        const allTcMovs = parseTCMovementsFromHtml(tcHtml, MOVEMENT_SOURCE.credit_card_unbilled);
        movements.push(...allTcMovs);
        debugLog.push(`    Generic TC extraction: ${allTcMovs.length} movements`);
      }
    } catch (err) {
      debugLog.push(`    TC movements error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    // Try finding TC movements in nested iframes
    const contentUrl = findIframeUrl(iframeSrcs, IFRAME_PATTERNS.content);
    if (contentUrl) {
      try {
        const contentHtml = await fetchHtml(jar, resolveUrl(PORTAL_BASE, contentUrl));
        const innerIframes = extractIframeSrcs(contentHtml);
        const innerTcUrl = findIframeUrl(innerIframes, IFRAME_PATTERNS.tcMovements);
        if (innerTcUrl) {
          const tcHtml = await fetchHtml(jar, resolveUrl(PORTAL_BASE, innerTcUrl));
          const tcMovs = parseTCMovementsFromHtml(tcHtml, MOVEMENT_SOURCE.credit_card_unbilled);
          movements.push(...tcMovs);
          debugLog.push(`    Nested TC movements: ${tcMovs.length}`);
        }
      } catch { /* ignore nested iframe errors */ }
    }
    debugLog.push("  No TC movements iframe found");
  }

  // TC cupo (credit limit / balance)
  const cupoUrl = findIframeUrl(iframeSrcs, IFRAME_PATTERNS.tcCupo);
  if (cupoUrl) {
    debugLog.push(`  Loading TC cupo iframe: ${cupoUrl}`);
    try {
      const cupoHtml = await fetchHtml(jar, resolveUrl(PORTAL_BASE, cupoUrl));
      const cupoData = parseCupoFromHtml(cupoHtml);

      // Extract card labels from the cupo page
      const cupoText = stripHtml(cupoHtml);
      const cardLabelMatch = cupoText.match(/(visa|mastercard|amex|american express)\s+\w+\s+\*+\d+/gi);
      const cardLabel = cardLabelMatch ? cardLabelMatch[0] : "Tarjeta BCI";

      const card: CreditCardBalance = {
        label: cardLabel,
        national: {
          used: cupoData.nationalUsed,
          available: cupoData.nationalAvailable,
          total: cupoData.nationalTotal,
        },
      };
      if (cupoData.internationalTotal > 0) {
        card.international = {
          used: cupoData.internationalUsed,
          available: cupoData.internationalAvailable,
          total: cupoData.internationalTotal,
          currency: "USD",
        };
      }
      creditCards.push(card);
    } catch (err) {
      debugLog.push(`    TC cupo error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    debugLog.push("  No TC cupo iframe found");
  }

  return { movements, creditCards };
}

// ─── Main scrape function ───────────────────────────────────────

async function scrapeBci(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const bank = "bci";
  const progress = onProgress || (() => {});

  progress("Conectando con BCI API...");
  const loginResult = await bciLogin(rut, password, debugLog);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar, portalHtml } = loginResult;
  progress("Sesi\u00f3n iniciada correctamente");

  // Account movements
  debugLog.push("5. Fetching account movements...");
  progress("Extrayendo movimientos de cuenta...");
  const acctResult = await fetchAccountMovements(jar, portalHtml, debugLog);
  debugLog.push(`  Account movements: ${acctResult.movements.length}`);

  // Credit card data
  debugLog.push("6. Fetching credit card data...");
  progress("Extrayendo datos de tarjeta de cr\u00e9dito...");
  const tcResult = await fetchCreditCardData(jar, portalHtml, debugLog);
  debugLog.push(`  TC movements: ${tcResult.movements.length}`);

  const deduplicated = deduplicateMovements([...acctResult.movements, ...tcResult.movements]);
  debugLog.push(`7. Total: ${deduplicated.length} unique movements`);
  progress(`Listo \u2014 ${deduplicated.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance: acctResult.balance,
    creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const bci: BankScraper = {
  id: "bci",
  name: "BCI",
  url: "https://www.bci.cl/personas",
  mode: "api",
  scrape: (options) => runApiScraper("bci", options, scrapeBci),
};

export default bci;
