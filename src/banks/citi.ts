import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { parseChileanAmount, normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Citibank constants ─────────────────────────────────────────
//
// Auth: Form-based login at online.citi.com
// Data: REST API for accounts, CSV download for movements
// Note: ioBlackBox (ThreatMetrix) is NOT sent — we attempt login without it.
//       If bot detection blocks us, the error will be clear.
//
// No browser needed — this scraper uses fetch() exclusively.

const HOME_URL = "https://www.citi.com";
const SIGNON_URL = "https://online.citi.com/US/login.do";
const ACCOUNTS_URL = "https://online.citi.com/US/REST/accountsPanel/getCustomerAccounts.jws";
const CSV_DOWNLOAD_URL = "https://online.citi.com/US/NCSC/dcd/StatementDownload.do";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

/** Extract form action URL from HTML */
function extractFormAction(html: string): string | null {
  // Look for form with login-related attributes
  const formMatch = html.match(/<form[^>]*action=["']([^"']+)["'][^>]*>/i);
  return formMatch ? formMatch[1] : null;
}

/** Extract hidden input fields from HTML (CSRF tokens, etc.) */
function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const regex = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(/name=["']([^"']+)["']/i);
    const valueMatch = tag.match(/value=["']([^"']*?)["']/i);
    if (nameMatch) {
      fields[nameMatch[1]] = valueMatch ? valueMatch[1] : "";
    }
  }
  return fields;
}

/** Check if HTML contains 2FA challenge indicators */
function is2FAChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("verification code") ||
    lower.includes("one-time") ||
    lower.includes("verify your identity") ||
    lower.includes("security code") ||
    lower.includes("one time password") ||
    lower.includes("otp") ||
    lower.includes("we sent") ||
    lower.includes("enter the code")
  );
}

/** Check if HTML contains login error indicators */
function extractLoginError(html: string): string | null {
  const lower = html.toLowerCase();
  const errorKeywords = ["incorrect", "invalid", "failed", "try again", "incorrecto", "no match", "wrong password", "locked", "suspended"];
  for (const kw of errorKeywords) {
    if (lower.includes(kw)) {
      // Try to extract a more specific error message from common error containers
      const errorMatch = html.match(/<(?:div|span|p)[^>]*(?:class|id)=["'][^"']*error[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p)>/i);
      if (errorMatch) {
        const text = errorMatch[1].replace(/<[^>]+>/g, "").trim();
        if (text.length > 0 && text.length < 300) return text;
      }
      return `Login error detected (keyword: "${kw}")`;
    }
  }
  return null;
}

// ─── Login ──────────────────────────────────────────────────────

async function citiLogin(
  username: string,
  password: string,
  debugLog: string[],
  onTwoFactorCode?: () => Promise<string>,
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  const jar = createCookieJar();

  // Step 1: GET home page for initial cookies
  debugLog.push("1. Fetching Citi home page for initial cookies...");
  const homeRes = await fetch(HOME_URL, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
  });
  jar.setAll(homeRes.headers);
  debugLog.push(`  Status: ${homeRes.status}, cookies: ${jar.cookies.size}`);

  // Step 2: GET signon page to collect form details and additional cookies
  debugLog.push("2. Fetching signon page...");
  const signonRes = await fetch(SIGNON_URL, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Cookie: jar.header(),
      Referer: HOME_URL,
    },
    redirect: "follow",
  });
  jar.setAll(signonRes.headers);
  const signonHtml = await signonRes.text();
  debugLog.push(`  Signon status: ${signonRes.status}, HTML length: ${signonHtml.length}`);

  // Step 3: Parse form action and hidden fields
  debugLog.push("3. Parsing login form...");
  const formAction = extractFormAction(signonHtml);
  const hiddenFields = extractHiddenFields(signonHtml);
  debugLog.push(`  Form action: ${formAction || "(not found)"}`);
  debugLog.push(`  Hidden fields: ${Object.keys(hiddenFields).join(", ") || "(none)"}`);

  // Build login POST URL
  let loginPostUrl: string;
  if (formAction) {
    loginPostUrl = formAction.startsWith("http") ? formAction : `https://online.citi.com${formAction}`;
  } else {
    // Fallback: post to the signon URL itself
    loginPostUrl = SIGNON_URL;
  }

  // Step 4: POST credentials (form-urlencoded, NO ioBlackBox)
  debugLog.push("4. Submitting credentials...");
  const body = new URLSearchParams({
    ...hiddenFields,
    username: username,
    password: password,
  });
  // Explicitly remove ioBlackBox if present in hidden fields (we skip it)
  // But keep it empty if the form expects it
  if (hiddenFields["ioBlackBox"] !== undefined) {
    body.set("ioBlackBox", "");
  }

  const loginRes = await fetch(loginPostUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Cookie: jar.header(),
      Referer: SIGNON_URL,
      Origin: "https://online.citi.com",
    },
    body: body.toString(),
    redirect: "manual",
  });
  jar.setAll(loginRes.headers);

  const location = loginRes.headers.get("location") || "";
  debugLog.push(`  Login response: ${loginRes.status}, Location: ${location}`);

  // Step 5: Follow redirects collecting cookies
  let finalHtml = "";
  let currentUrl = "";

  if (loginRes.status >= 300 && loginRes.status < 400 && location) {
    debugLog.push("5. Following redirects...");
    let redirectUrl: string | null = location.startsWith("http") ? location : `https://online.citi.com${location}`;
    let redirectCount = 0;

    while (redirectUrl && redirectCount < 10) {
      redirectCount++;
      const redirectRes: Response = await fetch(redirectUrl, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: jar.header(),
          Referer: SIGNON_URL,
        },
        redirect: "manual",
      });
      jar.setAll(redirectRes.headers);
      currentUrl = redirectUrl;

      const nextLocation: string = redirectRes.headers.get("location") || "";
      if (redirectRes.status >= 300 && redirectRes.status < 400 && nextLocation) {
        redirectUrl = nextLocation.startsWith("http") ? nextLocation : `https://online.citi.com${nextLocation}`;
        debugLog.push(`  Redirect ${redirectCount}: ${redirectRes.status} -> ${redirectUrl}`);
      } else {
        finalHtml = await redirectRes.text();
        debugLog.push(`  Final: ${redirectRes.status}, URL: ${currentUrl}, HTML length: ${finalHtml.length}`);
        redirectUrl = null;
      }
    }
  } else {
    finalHtml = await loginRes.text();
    currentUrl = loginPostUrl;
    debugLog.push(`  No redirect, reading response body. HTML length: ${finalHtml.length}`);
  }

  // Step 6: Check for login errors
  const loginError = extractLoginError(finalHtml);
  if (loginError) {
    return { success: false, error: `Error de login: ${loginError}` };
  }

  // Step 7: Check for 2FA challenge
  if (is2FAChallenge(finalHtml)) {
    debugLog.push("6. 2FA challenge detected");
    if (!onTwoFactorCode) {
      return { success: false, error: "Se requiere codigo 2FA pero no se proporciono callback onTwoFactorCode." };
    }

    const code = await onTwoFactorCode();
    debugLog.push(`  2FA code received (length: ${code.length})`);

    // Find the 2FA form action and hidden fields
    const twoFAAction = extractFormAction(finalHtml);
    const twoFAHidden = extractHiddenFields(finalHtml);
    const twoFAUrl = twoFAAction
      ? (twoFAAction.startsWith("http") ? twoFAAction : `https://online.citi.com${twoFAAction}`)
      : currentUrl;

    const twoFABody = new URLSearchParams({
      ...twoFAHidden,
      // Common field names for 2FA code
      otpCode: code,
      verificationCode: code,
      code: code,
    });

    const twoFARes = await fetch(twoFAUrl, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: jar.header(),
        Referer: currentUrl,
        Origin: "https://online.citi.com",
      },
      body: twoFABody.toString(),
      redirect: "follow",
    });
    jar.setAll(twoFARes.headers);
    const twoFAHtml = await twoFARes.text();
    debugLog.push(`  2FA response: ${twoFARes.status}, HTML length: ${twoFAHtml.length}`);

    const twoFAError = extractLoginError(twoFAHtml);
    if (twoFAError) {
      return { success: false, error: `Error 2FA: ${twoFAError}` };
    }
    if (is2FAChallenge(twoFAHtml)) {
      return { success: false, error: "Codigo 2FA rechazado o expirado." };
    }
  }

  // Check if we landed on a known post-login page
  if (currentUrl.includes("login") || currentUrl.includes("signon")) {
    // Might still be on login page
    if (!finalHtml.includes("accountsPanel") && !finalHtml.includes("dashboard") && !finalHtml.includes("Welcome")) {
      return { success: false, error: `Login no completado. URL final: ${currentUrl}. Posible bloqueo por ioBlackBox.` };
    }
  }

  debugLog.push(`  Login OK! Cookies: ${jar.cookies.size}`);
  return { success: true, jar };
}

// ─── CSV parsing ────────────────────────────────────────────────

function parseCitiCsv(csv: string): BankMovement[] {
  const lines = csv.split("\n").filter((l) => l.trim());
  const movements: BankMovement[] = [];
  // Skip header row
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

// ─── Data extraction ────────────────────────────────────────────

async function fetchAccounts(jar: CookieJar, debugLog: string[]): Promise<unknown> {
  debugLog.push("  Fetching accounts via REST...");
  const res = await fetch(ACCOUNTS_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: "https://online.citi.com/US/ag/dashboard",
      Origin: "https://online.citi.com",
    },
    body: JSON.stringify({}),
  });
  jar.setAll(res.headers);
  if (!res.ok) {
    debugLog.push(`  Accounts REST failed: ${res.status}`);
    return null;
  }
  const data = await res.json();
  debugLog.push(`  Accounts REST OK: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function downloadCsv(jar: CookieJar, debugLog: string[]): Promise<BankMovement[]> {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth() - 3, 1);
  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

  const params = new URLSearchParams({
    fromDate: fmt(from),
    toDate: fmt(today),
    downloadType: "CSV",
  });

  const url = `${CSV_DOWNLOAD_URL}?${params}`;
  debugLog.push(`  Downloading CSV: ${url}`);

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/csv,text/plain,*/*",
      Cookie: jar.header(),
      Referer: "https://online.citi.com/US/ag/dashboard",
    },
  });
  jar.setAll(res.headers);

  if (!res.ok) {
    debugLog.push(`  CSV download failed: ${res.status}`);
    return [];
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text") && !contentType.includes("csv")) {
    debugLog.push(`  CSV download returned unexpected content-type: ${contentType}`);
    return [];
  }

  const csvText = await res.text();
  debugLog.push(`  CSV download OK, length: ${csvText.length}`);
  if (csvText.length < 10) {
    debugLog.push("  CSV is empty or too short");
    return [];
  }

  return parseCitiCsv(csvText);
}

// ─── Main scrape function ───────────────────────────────────────

async function scrapeCiti(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: username, password, onProgress, onTwoFactorCode } = options;
  const bank = "citi";
  const progress = onProgress || (() => {});

  // Login
  progress("Conectando con Citibank API...");
  const loginResult = await citiLogin(username, password, debugLog, onTwoFactorCode);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar } = loginResult;
  progress("Sesion iniciada correctamente");

  // Fetch accounts (informational — the CSV is our main data source)
  debugLog.push("7. Fetching account data...");
  progress("Obteniendo cuentas...");
  await fetchAccounts(jar, debugLog);

  // Download CSV with movements
  debugLog.push("8. Downloading CSV movements...");
  progress("Descargando movimientos...");
  const csvMovements = await downloadCsv(jar, debugLog);
  debugLog.push(`  CSV movements: ${csvMovements.length}`);

  const deduplicated = deduplicateMovements(csvMovements);
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
  mode: "api",
  scrape: (options) => runApiScraper("citi", options, scrapeCiti),
};

export default citi;
