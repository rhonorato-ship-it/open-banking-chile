import type { BankMovement, BankScraper, CreditCardBalance, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, parseChileanAmount, normalizeDate, deduplicateMovements, normalizeInstallments, delay } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Itau constants ──────────────────────────────────────────────
//
// Auth: WPS (IBM WebSphere Portal) form-login at banco.itau.cl
// Data: Server-rendered HTML pages (not JSON APIs)
// Bot protection: Imperva/Incapsula — may block plain fetch()
//
// No browser needed — this scraper uses fetch() + HTML parsing.

const LOGIN_URL = "https://banco.itau.cl/wps/portal/newolb/web/login";
const PORTAL_BASE = "https://banco.itau.cl/wps/myportal/newolb/web";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TWO_FACTOR_KEYWORDS = ["itaú key", "itau key", "aprueba", "segundo factor", "autoriza"];
const REJECTION_KEYWORDS = ["rechazad", "denegad", "cancelad"];

// ─── Cookie jar ──────────────────────────────────────────────────

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

// ─── HTML fetch helper ───────────────────────────────────────────

async function fetchHtml(jar: CookieJar, url: string, referer?: string): Promise<{ status: number; html: string; headers: Headers }> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-CL,es;q=0.9,en;q=0.8",
      Cookie: jar.header(),
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: "follow",
  });
  jar.setAll(res.headers);
  const html = await res.text();
  return { status: res.status, html, headers: res.headers };
}

// ─── Login ───────────────────────────────────────────────────────

async function itauLogin(
  rut: string,
  password: string,
  debugLog: string[],
  onProgress?: (step: string) => void,
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  const jar = createCookieJar();
  const progress = onProgress || (() => {});

  // Step 1: GET login page to collect cookies and parse form
  debugLog.push("1. Fetching login page...");
  const loginPage = await fetchHtml(jar, LOGIN_URL);
  debugLog.push(`  Status: ${loginPage.status}, cookies: ${jar.cookies.size}`);

  // Check for Imperva block
  if (loginPage.html.includes("No pudimos validar tu acceso") || loginPage.html.includes("Please stand by")) {
    return {
      success: false,
      error: "Itau bloqueo el acceso (Imperva). Usa --profile para Chrome con perfil real.",
    };
  }

  // Parse form action URL from the login page HTML
  // WPS forms often have a dynamic action URL
  const formActionMatch = loginPage.html.match(/<form[^>]*id="[^"]*login[^"]*"[^>]*action="([^"]+)"/i)
    || loginPage.html.match(/<form[^>]*action="([^"]+)"[^>]*id="[^"]*login[^"]*"/i)
    || loginPage.html.match(/<form[^>]*action="([^"]+)"[^>]*>/i);
  const formAction = formActionMatch ? formActionMatch[1].replace(/&amp;/g, "&") : LOGIN_URL;
  const actionUrl = formAction.startsWith("http") ? formAction : `https://banco.itau.cl${formAction}`;
  debugLog.push(`  Form action: ${actionUrl}`);

  // Parse hidden fields from the form
  const hiddenFields: Record<string, string> = {};
  const hiddenRegex = /<input[^>]*type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*>/gi;
  let hiddenMatch: RegExpExecArray | null;
  while ((hiddenMatch = hiddenRegex.exec(loginPage.html)) !== null) {
    hiddenFields[hiddenMatch[1]] = hiddenMatch[2].replace(/&amp;/g, "&");
  }
  // Also try reversed attribute order (value before name)
  const hiddenRegex2 = /<input[^>]*type=["']hidden["'][^>]*value=["']([^"']*)["'][^>]*name=["']([^"']+)["'][^>]*>/gi;
  while ((hiddenMatch = hiddenRegex2.exec(loginPage.html)) !== null) {
    if (!hiddenFields[hiddenMatch[2]]) {
      hiddenFields[hiddenMatch[2]] = hiddenMatch[1].replace(/&amp;/g, "&");
    }
  }
  debugLog.push(`  Hidden fields: ${Object.keys(hiddenFields).join(", ") || "(none)"}`);

  // Step 2: POST credentials
  debugLog.push("2. Submitting credentials...");
  progress("Enviando credenciales...");
  const formattedRut = formatRut(rut);
  const body = new URLSearchParams({
    ...hiddenFields,
    loginNameID: formattedRut,
    pswdId: password,
  });

  const loginRes = await fetch(actionUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
      Referer: LOGIN_URL,
      Origin: "https://banco.itau.cl",
    },
    body: body.toString(),
    redirect: "manual",
  });
  jar.setAll(loginRes.headers);

  const location = loginRes.headers.get("location") || "";
  debugLog.push(`  Login response: ${loginRes.status}, Location: ${location}`);

  // Step 3: Follow redirects
  let currentUrl = location;
  let responseHtml = "";
  const maxRedirects = 10;

  for (let i = 0; i < maxRedirects && currentUrl; i++) {
    const redirectUrl = currentUrl.startsWith("http") ? currentUrl : `https://banco.itau.cl${currentUrl}`;
    debugLog.push(`  Following redirect ${i + 1}: ${redirectUrl}`);
    const redirectRes = await fetch(redirectUrl, {
      headers: {
        "User-Agent": UA,
        Cookie: jar.header(),
        Referer: LOGIN_URL,
      },
      redirect: "manual",
    });
    jar.setAll(redirectRes.headers);
    currentUrl = redirectRes.headers.get("location") || "";

    if (!currentUrl) {
      responseHtml = await redirectRes.text();
    }
  }

  // If no redirects happened, read the login response body
  if (!responseHtml && loginRes.status === 200) {
    responseHtml = await loginRes.text();
  }

  // Check for login errors in the response
  const lowerHtml = responseHtml.toLowerCase();
  if (lowerHtml.includes("incorrecto") || lowerHtml.includes("bloqueada") || lowerHtml.includes("suspendida") || lowerHtml.includes("inválido") || lowerHtml.includes("invalido")) {
    // Try to extract the specific error message
    const errorMatch = responseHtml.match(/<[^>]*(?:class|role)="[^"]*(?:error|alert)[^"]*"[^>]*>([^<]+)</i);
    const errorMsg = errorMatch ? errorMatch[1].trim() : "Credenciales incorrectas (RUT o clave invalida).";
    return { success: false, error: `Error de login: ${errorMsg}` };
  }

  // Check if we're still on the login page (login failed silently)
  if (lowerHtml.includes("loginnameid") && lowerHtml.includes("pswdid")) {
    return { success: false, error: "Credenciales incorrectas (RUT o clave invalida)." };
  }

  // Check for Imperva block after login attempt
  if (responseHtml.includes("No pudimos validar tu acceso") || responseHtml.includes("Please stand by")) {
    return {
      success: false,
      error: "Itau bloqueo el acceso (Imperva). Usa --profile para Chrome con perfil real.",
    };
  }

  // Step 4: Detect 2FA (Itau Key push notification)
  if (TWO_FACTOR_KEYWORDS.some(kw => lowerHtml.includes(kw))) {
    debugLog.push("3. 2FA detected (Itau Key), waiting for approval...");
    progress("Esperando aprobacion de Itau Key...");

    const timeoutSec = Math.min(600, Math.max(30, parseInt(process.env.ITAU_2FA_TIMEOUT_SEC || "180", 10) || 180));
    const start = Date.now();

    while ((Date.now() - start) / 1000 < timeoutSec) {
      await delay(3000);

      // Re-fetch the current page to check if 2FA was approved
      // The portal should redirect or change content after approval
      const checkUrl = location.startsWith("http") ? location : `${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`;
      const checkRes = await fetchHtml(jar, checkUrl, LOGIN_URL);
      const checkLower = checkRes.html.toLowerCase();

      // 2FA rejected
      if (REJECTION_KEYWORDS.some(kw => checkLower.includes(kw))) {
        debugLog.push("  2FA rejected.");
        return { success: false, error: "2FA rechazado (Itau Key)." };
      }

      // 2FA no longer showing = approved
      if (!TWO_FACTOR_KEYWORDS.some(kw => checkLower.includes(kw))) {
        debugLog.push("  2FA approved!");
        responseHtml = checkRes.html;
        break;
      }

      // Still waiting
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 15 === 0) {
        debugLog.push(`  Still waiting for 2FA approval... (${elapsed}s)`);
      }
    }

    if (TWO_FACTOR_KEYWORDS.some(kw => responseHtml.toLowerCase().includes(kw))) {
      return { success: false, error: "2FA no fue aprobado a tiempo (Itau Key)." };
    }
  }

  // Step 5: Verify login success by fetching the portal
  debugLog.push("4. Verifying portal access...");
  const portalCheck = await fetchHtml(jar, `${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`, LOGIN_URL);
  if (portalCheck.html.includes("loginNameID") || portalCheck.html.includes("Please stand by")) {
    return { success: false, error: "No se pudo acceder al portal despues del login. La sesion puede haber expirado." };
  }

  debugLog.push(`5. Login OK! Cookies: ${Array.from(jar.cookies.keys()).join(", ")}`);
  return { success: true, jar };
}

// ─── Data extraction ─────────────────────────────────────────────

function extractBalance(html: string, debugLog: string[]): number | undefined {
  debugLog.push("6. Extracting balance...");
  const match = html.match(/Saldo disponible para uso\s*\$\s*([\d.,]+)/);
  if (match) {
    const balance = parseInt(match[1].replace(/[^0-9]/g, ""), 10);
    debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
    return balance;
  }
  debugLog.push("  Balance not found in page");
  return undefined;
}

async function extractMovements(jar: CookieJar, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("7. Extracting movements...");
  const allMovements: BankMovement[] = [];

  const movPage = await fetchHtml(jar, `${PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`, `${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`);

  let currentHtml = movPage.html;

  for (let pageNum = 1; pageNum <= 10; pageNum++) {
    // Parse table rows from HTML
    // Each movement row has 6 cells: date, description, cargo, abono, saldo, extra
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    let pageMovCount = 0;

    while ((rowMatch = rowRegex.exec(currentHtml)) !== null) {
      const rowHtml = rowMatch[1];
      // Extract all <td> cell contents
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        // Strip HTML tags and trim
        cells.push(cellMatch[1].replace(/<[^>]*>/g, "").trim());
      }

      if (cells.length !== 6) continue;

      const dateText = cells[0];
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateText)) continue;

      const description = cells[1];
      const cargoVal = parseChileanAmount(cells[2]);
      const abonoVal = parseChileanAmount(cells[3]);
      const saldoVal = parseChileanAmount(cells[4]);
      const amount = abonoVal > 0 ? abonoVal : -cargoVal;
      if (amount === 0) continue;

      allMovements.push({
        date: normalizeDate(dateText),
        description,
        amount,
        balance: saldoVal,
        source: MOVEMENT_SOURCE.account,
      });
      pageMovCount++;
    }

    debugLog.push(`  Page ${pageNum}: ${pageMovCount} movements`);

    // Check for pagination: "Pagina X de Y"
    const pageInfoMatch = currentHtml.match(/P[aá]gina\s+(\d+)\s+de\s+(\d+)/i);
    if (pageInfoMatch && parseInt(pageInfoMatch[1], 10) >= parseInt(pageInfoMatch[2], 10)) break;

    // Look for next page link
    const nextLinkMatch = currentHtml.match(/<a[^>]*name=["']nextbtn["'][^>]*href=["']([^"']+)["']/i)
      || currentHtml.match(/<a[^>]*href=["']([^"']+)["'][^>]*name=["']nextbtn["']/i);
    if (!nextLinkMatch) break;

    const nextUrl = nextLinkMatch[1].replace(/&amp;/g, "&");
    const fullNextUrl = nextUrl.startsWith("http") ? nextUrl : `https://banco.itau.cl${nextUrl}`;
    const nextPage = await fetchHtml(jar, fullNextUrl, `${PORTAL_BASE}/cuentas/cuenta-corriente/saldos-ultimo-movimiento`);
    currentHtml = nextPage.html;
  }

  return allMovements;
}

async function extractCreditCardData(jar: CookieJar, debugLog: string[]): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  debugLog.push("8. Extracting credit card data...");
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  // Fetch deuda page
  const deudaPage = await fetchHtml(jar, `${PORTAL_BASE}/tarjeta-credito/resumen/deuda`, PORTAL_BASE);
  const deudaHtml = deudaPage.html;
  const deudaText = deudaHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

  // Extract card label
  const cardMatch = deudaText.match(/(Mastercard|Visa)\s+[\w\s]+\*{4}\s*\*{4}\s*\*{4}\s*(\d{4})/i);
  const cardLabel = cardMatch
    ? cardMatch[0].replace(/\*{4}\s*\*{4}\s*\*{4}\s*/, "****").replace(/\s+/g, " ").trim()
    : null;

  if (!cardLabel) {
    debugLog.push("  No credit card found");
    return { movements, creditCards };
  }

  debugLog.push(`  Card: ${cardLabel}`);

  // Extract national cupo
  const nacSection = deudaText.match(/Nacional[\s\S]*?(?=Internacional|Ofertas|Movimientos|$)/)?.[0] || "";
  const nacDisponible = nacSection.match(/Cupo disponible\s*\$\s*([\d.]+)/);
  const nacUtilizado = nacSection.match(/Cupo utilizado[\s\S]*?\$\s*([\d.]+)/);
  const nacUsed = parseChileanAmount(nacUtilizado?.[1] || "0");
  const nacAvailable = parseChileanAmount(nacDisponible?.[1] || "0");

  const card: CreditCardBalance = {
    label: cardLabel,
    national: { used: nacUsed, available: nacAvailable, total: nacUsed + nacAvailable },
  };

  // Extract international cupo
  const intSection = deudaText.match(/Internacional[\s\S]*?(?=Ofertas|Movimientos|Emergencias|$)/)?.[0] || "";
  const intUsdValues = [...intSection.matchAll(/USD\$?\s*(-?[\d.,]+)/g)].map(m => m[1]);
  if (intUsdValues.length >= 3) {
    const parseUsd = (s: string) => parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0;
    card.international = {
      used: Math.abs(parseUsd(intUsdValues[1] || "0")),
      available: parseUsd(intUsdValues[2] || "0"),
      total: parseUsd(intUsdValues[0] || "0"),
      currency: "USD",
    };
  }

  // Next billing date
  const proxFactMatch = deudaText.match(/Pr[oó]xima facturaci[oó]n\s*(\d{2}\/\d{2}\/\d{4})/);
  if (proxFactMatch) card.nextBillingDate = normalizeDate(proxFactMatch[1]);

  creditCards.push(card);

  // Extract no-facturados from deuda page tables
  // Look for tables preceded by "no facturad" text
  const noFactTableRegex = /no\s*facturad[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/gi;
  let noFactMatch: RegExpExecArray | null;
  let noFactCount = 0;

  while ((noFactMatch = noFactTableRegex.exec(deudaHtml)) !== null) {
    const tableHtml = noFactMatch[1];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      // Skip header rows
      if (rowHtml.includes("<th")) continue;

      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(cellMatch[1].replace(/<[^>]*>/g, "").trim());
      }

      if (cells.length >= 3) {
        const amount = parseChileanAmount(cells[cells.length - 1]);
        if (amount === 0) continue;
        movements.push({
          date: normalizeDate(cells[0]),
          description: cells[1],
          amount: -amount,
          balance: 0,
          source: MOVEMENT_SOURCE.credit_card_unbilled,
        });
        noFactCount++;
      }
    }
  }
  debugLog.push(`  No-facturados: ${noFactCount}`);

  // Fetch facturados (billed transactions)
  const factPage = await fetchHtml(jar, `${PORTAL_BASE}/tarjeta-credito/resumen/cuenta-nacional`, `${PORTAL_BASE}/tarjeta-credito/resumen/deuda`);
  const factHtml = factPage.html;

  // Parse facturados table - 7+ cells per row
  const factRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let factRowMatch: RegExpExecArray | null;
  let factCount = 0;

  while ((factRowMatch = factRowRegex.exec(factHtml)) !== null) {
    const rowHtml = factRowMatch[1];
    if (rowHtml.includes("<th")) continue;

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]*>/g, "").trim());
    }

    if (cells.length < 7) continue;

    // cells[1] = date, cells[3] = description, cells[4] = amount, cells[6] = cuota
    const dateText = cells[1];
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateText)) continue;

    const amount = parseChileanAmount(cells[4]);
    if (amount === 0) continue;

    movements.push({
      date: normalizeDate(dateText),
      description: cells[3],
      amount: amount > 0 ? -amount : Math.abs(amount),
      balance: 0,
      source: MOVEMENT_SOURCE.credit_card_billed,
      installments: normalizeInstallments(cells[6]),
    });
    factCount++;
  }
  debugLog.push(`  Facturados: ${factCount}`);

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeItau(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const bank = "itau";
  const progress = onProgress || (() => {});

  progress("Conectando con Itau API...");
  const loginResult = await itauLogin(rut, password, debugLog, onProgress);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar } = loginResult;
  progress("Sesion iniciada correctamente");

  // Fetch balance page (reuse for balance extraction)
  progress("Extrayendo saldo...");
  const balancePage = await fetchHtml(jar, `${PORTAL_BASE}/cuentas/cuenta-corriente/saldos`, PORTAL_BASE);
  const balance = extractBalance(balancePage.html, debugLog);

  // Fetch account movements
  progress("Extrayendo movimientos de cuenta...");
  const accountMovements = await extractMovements(jar, debugLog);
  progress(`Cuenta: ${accountMovements.length} movimientos`);

  // Fetch credit card data
  progress("Extrayendo datos de tarjeta de credito...");
  let tcResult: { movements: BankMovement[]; creditCards: CreditCardBalance[] };
  try {
    tcResult = await extractCreditCardData(jar, debugLog);
  } catch (err) {
    debugLog.push(`  TC error: ${err instanceof Error ? err.message : String(err)}`);
    tcResult = { movements: [], creditCards: [] };
  }

  const deduplicated = deduplicateMovements([...accountMovements, ...tcResult.movements]);
  debugLog.push(`9. Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

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
  mode: "api",
  scrape: (options) => runApiScraper("itau", options, scrapeItau),
};

export default itau;
