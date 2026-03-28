import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── BICE constants ─────────────────────────────────────────────
//
// Auth: Keycloak OIDC at auth.bice.cl/realms/personas
// Gateway: gw.bice.cl (OAuth agent proxy + BFF endpoints)
//
// Flow:
//   1. GET portalpersonas.bice.cl → redirect to Keycloak → parse <form action> → POST creds
//   2. Keycloak redirects back with auth code in URL
//   3. POST gw.bice.cl/oauth-agent-personas/login/start → initiate OAuth agent session
//   4. POST gw.bice.cl/oauth-agent-personas/login/end → complete session, get cookies
//   5. Use session cookies to call BFF endpoints on gw.bice.cl
//
// No browser needed — this scraper uses fetch() exclusively.

const PORTAL_URL = "https://portalpersonas.bice.cl";
const GW_BASE = "https://gw.bice.cl";
const OAUTH_AGENT = `${GW_BASE}/oauth-agent-personas`;
const BFF_PRODUCTS = `${GW_BASE}/portalpersonas/bff-portal-hbp/v1/products`;
const BFF_BALANCE = `${GW_BASE}/portalpersonas/bff-checking-account-transactions-100/v1/balance`;
const BFF_TRANSACTIONS = `${GW_BASE}/portalpersonas/bff-checking-account-transactions-100/v1/transactions`;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── Cookie jar (domain-aware) ──────────────────────────────────

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
      if (eqIdx > 0)
        cookies.set(
          nameValue.slice(0, eqIdx).trim(),
          nameValue.slice(eqIdx + 1).trim(),
        );
    },
    setAll(headers: Headers) {
      const setCookies = headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) this.set(raw);
    },
    header() {
      return Array.from(cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    },
  };
}

// ─── HTML parsing helpers ────────────────────────────────────────

/** Extract the Keycloak form action URL from the login page HTML */
function parseKeycloakFormAction(html: string): string | null {
  const match =
    html.match(
      /<form[^>]*id=["']kc-form-login["'][^>]*action=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<form[^>]*action=["']([^"']+)["'][^>]*id=["']kc-form-login["']/i,
    );
  if (match) return match[1].replace(/&amp;/g, "&");
  // Fallback: any form with action containing auth.bice.cl
  const fallback = html.match(
    /<form[^>]*action=["'](https?:\/\/auth\.bice\.cl[^"']+)["']/i,
  );
  if (fallback) return fallback[1].replace(/&amp;/g, "&");
  return null;
}

/** Check if the HTML contains Keycloak error/feedback messages */
function parseKeycloakError(html: string): string | null {
  const errorMatch = html.match(
    /<span[^>]*class=["'][^"']*kc-feedback-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  );
  if (errorMatch) {
    const text = errorMatch[1].replace(/<[^>]+>/g, "").trim();
    if (text) return text;
  }
  const alertMatch = html.match(
    /<div[^>]*class=["'][^"']*alert[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  if (alertMatch) {
    const text = alertMatch[1].replace(/<[^>]+>/g, "").trim();
    if (text) return text;
  }
  return null;
}

/** Detect 2FA indicators in Keycloak page */
function is2FAPage(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("otp") ||
    lower.includes("two-factor") ||
    lower.includes("segundo factor") ||
    lower.includes("verificaci") ||
    (lower.includes("code") && lower.includes("sms")) ||
    lower.includes("kc-form-otp") ||
    lower.includes("authenticator")
  );
}

/** Extract auth code and state from a Keycloak redirect URL */
function extractAuthParams(url: string): { code: string; state: string } | null {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (code && state) return { code, state };
    // Also check the hash fragment (some OIDC flows use fragment)
    if (parsed.hash) {
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      const hCode = hashParams.get("code");
      const hState = hashParams.get("state");
      if (hCode && hState) return { code: hCode, state: hState };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Login ───────────────────────────────────────────────────────

async function biceKeycloakLogin(
  rut: string,
  password: string,
  debugLog: string[],
  onTwoFactorCode?: () => Promise<string>,
): Promise<
  | { success: true; portalJar: CookieJar; gwJar: CookieJar }
  | { success: false; error: string }
> {
  const portalJar = createCookieJar(); // Cookies for portalpersonas.bice.cl
  const gwJar = createCookieJar(); // Cookies for gw.bice.cl

  // Step 1: GET portal — follow redirects manually to collect cookies and land on Keycloak
  debugLog.push("1. Fetching portal (triggers Keycloak redirect)...");
  let currentUrl: string = PORTAL_URL;
  let loginHtml = "";
  let maxHops = 15;
  while (maxHops-- > 0) {
    const res = await fetch(currentUrl, {
      headers: { "User-Agent": UA, Cookie: portalJar.header() },
      redirect: "manual",
    });
    portalJar.setAll(res.headers);
    const location = res.headers.get("location");
    if (location) {
      currentUrl = location.startsWith("http")
        ? location
        : new URL(location, currentUrl).href;
      debugLog.push(`  Redirect: ${currentUrl.slice(0, 100)}...`);
      continue;
    }
    loginHtml = await res.text();
    debugLog.push(
      `  Landed: ${currentUrl.slice(0, 80)} (${res.status}), cookies: ${portalJar.cookies.size}`,
    );
    break;
  }

  // Step 2: Parse Keycloak form action
  const formAction = parseKeycloakFormAction(loginHtml);
  if (!formAction) {
    debugLog.push("  ERROR: Could not find Keycloak form action in HTML");
    return {
      success: false,
      error: "No se encontro el formulario de login de Keycloak.",
    };
  }
  debugLog.push(`2. Found Keycloak form action: ${formAction.substring(0, 80)}...`);

  // Step 3: POST credentials — BICE Keycloak expects formatted RUT with dots
  debugLog.push("3. Submitting credentials to Keycloak...");
  const formattedRut = formatRut(rut);
  const body = new URLSearchParams({
    username: formattedRut,
    password: password,
  });

  const loginRes = await fetch(formAction, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: portalJar.header(),
      Referer: currentUrl,
      Origin: "https://auth.bice.cl",
    },
    body: body.toString(),
    redirect: "manual",
  });
  portalJar.setAll(loginRes.headers);

  const location = loginRes.headers.get("location") || "";
  debugLog.push(
    `  Login response: ${loginRes.status}, Location: ${location.substring(0, 100)}`,
  );

  // Status 200 = Keycloak sent back the login page (credentials wrong or 2FA)
  if (loginRes.status === 200) {
    const responseHtml = await loginRes.text();

    if (is2FAPage(responseHtml)) {
      debugLog.push("  2FA detected — requesting code...");
      if (!onTwoFactorCode) {
        return {
          success: false,
          error: "Se requiere codigo 2FA pero no hay callback configurado.",
        };
      }

      const code = await onTwoFactorCode();
      debugLog.push("  Submitting 2FA code...");
      const otpFormAction = parseKeycloakFormAction(responseHtml) || formAction;
      const otpBody = new URLSearchParams({ otp: code });

      const otpRes = await fetch(otpFormAction, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: portalJar.header(),
          Referer: currentUrl,
          Origin: "https://auth.bice.cl",
        },
        body: otpBody.toString(),
        redirect: "manual",
      });
      portalJar.setAll(otpRes.headers);

      const otpLocation = otpRes.headers.get("location") || "";
      debugLog.push(
        `  2FA response: ${otpRes.status}, Location: ${otpLocation.substring(0, 100)}`,
      );

      if (otpRes.status === 200) {
        const otpHtml = await otpRes.text();
        const otpError = parseKeycloakError(otpHtml);
        return {
          success: false,
          error: `Error 2FA: ${otpError || "Codigo incorrecto"}`,
        };
      }

      if (otpRes.status >= 300 && otpRes.status < 400 && otpLocation) {
        return await followKeycloakRedirectAndOAuth(
          portalJar,
          gwJar,
          otpLocation,
          debugLog,
        );
      }
    }

    const loginError = parseKeycloakError(responseHtml);
    return {
      success: false,
      error: `Credenciales incorrectas: ${loginError || "RUT o clave invalida."}`,
    };
  }

  // Status 302/303 = success, follow redirect chain and complete OAuth
  if (loginRes.status >= 300 && loginRes.status < 400 && location) {
    return await followKeycloakRedirectAndOAuth(
      portalJar,
      gwJar,
      location,
      debugLog,
    );
  }

  return {
    success: false,
    error: `Respuesta inesperada de Keycloak: ${loginRes.status}`,
  };
}

/**
 * Follow the Keycloak redirect chain to extract the auth code,
 * then complete the OAuth agent flow on gw.bice.cl.
 */
async function followKeycloakRedirectAndOAuth(
  portalJar: CookieJar,
  gwJar: CookieJar,
  initialLocation: string,
  debugLog: string[],
): Promise<
  | { success: true; portalJar: CookieJar; gwJar: CookieJar }
  | { success: false; error: string }
> {
  debugLog.push("4. Following Keycloak redirect chain...");
  let url = initialLocation;
  let hops = 0;
  const MAX_HOPS = 15;
  let authCode: string | null = null;
  let authState: string | null = null;

  // Follow redirects manually, looking for the auth code in redirect URLs
  while (hops < MAX_HOPS) {
    // Check if current URL contains the auth code (before following it)
    const params = extractAuthParams(url);
    if (params) {
      authCode = params.code;
      authState = params.state;
      debugLog.push(`  Found auth code at hop ${hops + 1}: code=${authCode.substring(0, 20)}..., state=${authState.substring(0, 20)}...`);
      break;
    }

    const res = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: portalJar.header() },
      redirect: "manual",
    });
    portalJar.setAll(res.headers);

    const nextLocation = res.headers.get("location") || "";
    debugLog.push(`  Hop ${hops + 1}: ${res.status} ${url.substring(0, 80)}...`);

    if (res.status >= 300 && res.status < 400 && nextLocation) {
      url = nextLocation.startsWith("http")
        ? nextLocation
        : new URL(nextLocation, url).href;

      // Check the redirect target for auth code
      const redirectParams = extractAuthParams(url);
      if (redirectParams) {
        authCode = redirectParams.code;
        authState = redirectParams.state;
        debugLog.push(
          `  Found auth code in redirect: code=${authCode.substring(0, 20)}..., state=${authState.substring(0, 20)}...`,
        );
        break;
      }

      hops++;
      continue;
    }

    // We landed on a 200 response — check if the final URL has auth params
    const finalParams = extractAuthParams(url);
    if (finalParams) {
      authCode = finalParams.code;
      authState = finalParams.state;
      debugLog.push(
        `  Found auth code in final URL: code=${authCode.substring(0, 20)}...`,
      );
      break;
    }

    // If we landed on the portal without an auth code, the redirect
    // may have been consumed by the SPA. Try extracting from the URL anyway.
    if (url.includes("portalpersonas.bice.cl")) {
      debugLog.push("  Landed on portal — checking URL for auth params...");
    }

    break;
  }

  if (!authCode) {
    // Fallback: try to use the session cookies we collected during the redirect chain
    // Some Keycloak setups exchange the code server-side via the SPA's redirect handler
    debugLog.push(
      "  No auth code found in redirects. Attempting direct OAuth agent flow...",
    );
    return await attemptOAuthAgentWithCookies(portalJar, gwJar, url, debugLog);
  }

  // Step 5: Complete OAuth agent flow on gw.bice.cl
  return await completeOAuthAgent(portalJar, gwJar, authCode, authState ?? "", url, debugLog);
}

/**
 * Complete the OAuth agent session using the auth code.
 * POST login/start with the code, then POST login/end.
 */
async function completeOAuthAgent(
  portalJar: CookieJar,
  gwJar: CookieJar,
  authCode: string,
  authState: string,
  pageUrl: string,
  debugLog: string[],
): Promise<
  | { success: true; portalJar: CookieJar; gwJar: CookieJar }
  | { success: false; error: string }
> {
  debugLog.push("5. Completing OAuth agent session on gw.bice.cl...");

  // POST login/start — initiates the OAuth agent session
  try {
    debugLog.push("  POST oauth-agent-personas/login/start...");
    const startRes = await fetch(`${OAUTH_AGENT}/login/start`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: gwJar.header(),
        Origin: PORTAL_URL,
        Referer: `${PORTAL_URL}/`,
      },
      body: JSON.stringify({
        code: authCode,
        state: authState,
      }),
    });
    gwJar.setAll(startRes.headers);
    const startBody = await startRes.text();
    debugLog.push(
      `  login/start: ${startRes.status}, cookies: ${gwJar.cookies.size}, body: ${startBody.substring(0, 200)}`,
    );

    if (!startRes.ok && startRes.status !== 302) {
      // Try alternative body shapes
      debugLog.push("  Retrying login/start with pageUrl...");
      const startRes2 = await fetch(`${OAUTH_AGENT}/login/start`, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: gwJar.header(),
          Origin: PORTAL_URL,
          Referer: `${PORTAL_URL}/`,
        },
        body: JSON.stringify({ pageUrl }),
      });
      gwJar.setAll(startRes2.headers);
      const startBody2 = await startRes2.text();
      debugLog.push(
        `  login/start (retry): ${startRes2.status}, body: ${startBody2.substring(0, 200)}`,
      );
    }
  } catch (err) {
    debugLog.push(
      `  login/start error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // POST login/end — completes the session, sets HTTP-only cookies
  try {
    debugLog.push("  POST oauth-agent-personas/login/end...");
    const endRes = await fetch(`${OAUTH_AGENT}/login/end`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: gwJar.header(),
        Origin: PORTAL_URL,
        Referer: `${PORTAL_URL}/`,
      },
      body: JSON.stringify({
        pageUrl,
      }),
    });
    gwJar.setAll(endRes.headers);
    const endBody = await endRes.text();
    debugLog.push(
      `  login/end: ${endRes.status}, cookies: ${gwJar.cookies.size}, body: ${endBody.substring(0, 200)}`,
    );

    if (!endRes.ok) {
      return {
        success: false,
        error: `OAuth agent login/end falló: ${endRes.status}`,
      };
    }
  } catch (err) {
    debugLog.push(
      `  login/end error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      success: false,
      error: `Error en OAuth agent: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Verify session by fetching userInfo
  try {
    debugLog.push("  GET oauth-agent-personas/userInfo...");
    const userInfoRes = await fetch(`${OAUTH_AGENT}/userInfo`, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: gwJar.header(),
        Origin: PORTAL_URL,
        Referer: `${PORTAL_URL}/`,
      },
    });
    gwJar.setAll(userInfoRes.headers);
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.text();
      debugLog.push(`  userInfo: ${userInfoRes.status}, body: ${userInfo.substring(0, 200)}`);
    } else {
      debugLog.push(`  userInfo: ${userInfoRes.status} (non-critical)`);
    }
  } catch {
    debugLog.push("  userInfo: failed (non-critical)");
  }

  debugLog.push(
    `6. OAuth agent session established. GW cookies: ${Array.from(gwJar.cookies.keys()).join(", ")}`,
  );
  return { success: true, portalJar, gwJar };
}

/**
 * Fallback: if no auth code was found in the redirect chain,
 * try the OAuth agent flow using only the session cookies.
 * The SPA might handle the code exchange client-side.
 */
async function attemptOAuthAgentWithCookies(
  portalJar: CookieJar,
  gwJar: CookieJar,
  landingUrl: string,
  debugLog: string[],
): Promise<
  | { success: true; portalJar: CookieJar; gwJar: CookieJar }
  | { success: false; error: string }
> {
  debugLog.push("5. (Fallback) Attempting OAuth agent with session cookies...");

  // The SPA's redirect handler (portalpersonas.bice.cl) may call login/start itself.
  // We replicate that call. The OAuth agent may accept the URL with code as pageUrl.
  try {
    const startRes = await fetch(`${OAUTH_AGENT}/login/start`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: gwJar.header(),
        Origin: PORTAL_URL,
        Referer: `${PORTAL_URL}/`,
      },
      body: JSON.stringify({ pageUrl: landingUrl }),
    });
    gwJar.setAll(startRes.headers);
    const startBody = await startRes.text();
    debugLog.push(
      `  login/start (fallback): ${startRes.status}, body: ${startBody.substring(0, 200)}`,
    );
  } catch (err) {
    debugLog.push(
      `  login/start (fallback) error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // POST login/end
  try {
    const endRes = await fetch(`${OAUTH_AGENT}/login/end`, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: gwJar.header(),
        Origin: PORTAL_URL,
        Referer: `${PORTAL_URL}/`,
      },
      body: JSON.stringify({ pageUrl: landingUrl }),
    });
    gwJar.setAll(endRes.headers);
    const endBody = await endRes.text();
    debugLog.push(
      `  login/end (fallback): ${endRes.status}, cookies: ${gwJar.cookies.size}, body: ${endBody.substring(0, 200)}`,
    );

    if (!endRes.ok) {
      return {
        success: false,
        error: `OAuth agent session falló (fallback): ${endRes.status}. Posiblemente el auth code expiró.`,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Error en OAuth agent (fallback): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  debugLog.push(
    `6. OAuth agent session established (fallback). GW cookies: ${Array.from(gwJar.cookies.keys()).join(", ")}`,
  );
  return { success: true, portalJar, gwJar };
}

// ─── BFF API helpers ─────────────────────────────────────────────

async function bffPost<T>(
  gwJar: CookieJar,
  url: string,
  body: unknown = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: gwJar.header(),
      Origin: PORTAL_URL,
      Referer: `${PORTAL_URL}/`,
    },
    body: JSON.stringify(body),
  });
  gwJar.setAll(res.headers);
  if (!res.ok) throw new Error(`BFF POST ${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── API response types ──────────────────────────────────────────

interface BiceProduct {
  id?: string;
  accountNumber?: string;
  productType?: string;
  productName?: string;
  currency?: string;
  balance?: number;
  availableBalance?: number;
  // Flexible: API shape may vary
  [key: string]: unknown;
}

interface BiceProductsResponse {
  products?: BiceProduct[];
  accounts?: BiceProduct[];
  data?: BiceProduct[];
  // Fallback: might be a flat array
  [key: string]: unknown;
}

interface BiceBalanceResponse {
  balance?: number;
  availableBalance?: number;
  saldo?: number;
  saldoDisponible?: number;
  // Fallback fields
  [key: string]: unknown;
}

interface BiceTransaction {
  date?: string;
  fecha?: string;
  transactionDate?: string;
  description?: string;
  descripcion?: string;
  glosa?: string;
  amount?: number;
  monto?: number;
  cargo?: number;
  abono?: number;
  balance?: number;
  saldo?: number;
  category?: string;
  tipo?: string;
  type?: string;
  [key: string]: unknown;
}

interface BiceTransactionsResponse {
  transactions?: BiceTransaction[];
  movimientos?: BiceTransaction[];
  data?: BiceTransaction[];
  content?: BiceTransaction[];
  // Pagination info
  totalPages?: number;
  totalElements?: number;
  page?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

// ─── Data extraction ─────────────────────────────────────────────

function biceTransactionToMovement(tx: BiceTransaction): BankMovement | null {
  // Extract date from various possible field names
  const dateStr = tx.date || tx.fecha || tx.transactionDate || "";
  if (!dateStr) return null;

  // Extract description
  const description = (tx.description || tx.descripcion || tx.glosa || "").trim();
  if (!description) return null;

  // Extract amount — BICE uses Cargos (negative) and Abonos (positive)
  let amount: number;
  if (tx.amount !== undefined && tx.amount !== null) {
    amount = tx.amount;
  } else if (tx.monto !== undefined && tx.monto !== null) {
    amount = tx.monto;
  } else if (tx.cargo !== undefined && Number(tx.cargo) > 0) {
    amount = -Math.abs(Number(tx.cargo));
  } else if (tx.abono !== undefined && Number(tx.abono) > 0) {
    amount = Math.abs(Number(tx.abono));
  } else {
    return null;
  }

  // If category/type says "Cargos" and amount is positive, flip to negative
  const category = (tx.category || tx.tipo || tx.type || "").toLowerCase();
  if (category.includes("cargo") && amount > 0) {
    amount = -amount;
  }
  // If category says "Abonos" and amount is negative, flip to positive
  if (category.includes("abono") && amount < 0) {
    amount = -amount;
  }

  const balance = tx.balance ?? tx.saldo ?? 0;

  return {
    date: normalizeDate(dateStr),
    description,
    amount,
    balance: typeof balance === "number" ? balance : 0,
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── Data fetching ───────────────────────────────────────────────

async function fetchProducts(
  gwJar: CookieJar,
  debugLog: string[],
): Promise<BiceProduct[]> {
  debugLog.push("  Fetching products...");
  try {
    const res = await bffPost<BiceProductsResponse>(gwJar, BFF_PRODUCTS);
    const products = res.products || res.accounts || res.data || [];

    // If the response is an array at the top level (not wrapped in an object)
    if (Array.isArray(res)) {
      debugLog.push(`  Products: ${(res as BiceProduct[]).length} (top-level array)`);
      return res as BiceProduct[];
    }

    debugLog.push(`  Products: ${products.length}`);
    return products;
  } catch (err) {
    debugLog.push(
      `  Products error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function fetchBalance(
  gwJar: CookieJar,
  debugLog: string[],
): Promise<number | undefined> {
  debugLog.push("  Fetching balance...");
  try {
    const res = await bffPost<BiceBalanceResponse>(gwJar, BFF_BALANCE);
    const balance =
      res.balance ??
      res.availableBalance ??
      res.saldo ??
      res.saldoDisponible;
    if (balance !== undefined && typeof balance === "number") {
      debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
      return balance;
    }
    debugLog.push(`  Balance response keys: ${Object.keys(res).join(", ")}`);
    return undefined;
  } catch (err) {
    debugLog.push(
      `  Balance error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function fetchTransactions(
  gwJar: CookieJar,
  debugLog: string[],
): Promise<BankMovement[]> {
  debugLog.push("  Fetching transactions...");
  const allMovements: BankMovement[] = [];

  try {
    // First page — try empty body, then with pagination params
    let res = await bffPost<BiceTransactionsResponse>(gwJar, BFF_TRANSACTIONS);
    let rawTxs = res.transactions || res.movimientos || res.data || res.content || [];

    // Handle top-level array
    if (Array.isArray(res)) {
      rawTxs = res as BiceTransaction[];
    }

    debugLog.push(`  Transactions page 1: ${rawTxs.length} items`);

    for (const tx of rawTxs) {
      const mov = biceTransactionToMovement(tx);
      if (mov) allMovements.push(mov);
    }

    // Paginate if the API supports it
    let page = 2;
    const MAX_PAGES = 20;
    let hasMore = res.hasMore === true || (res.totalPages !== undefined && page <= res.totalPages);

    while (hasMore && page <= MAX_PAGES) {
      try {
        res = await bffPost<BiceTransactionsResponse>(gwJar, BFF_TRANSACTIONS, {
          page,
          pageSize: 50,
        });
        rawTxs = res.transactions || res.movimientos || res.data || res.content || [];
        if (Array.isArray(res)) rawTxs = res as BiceTransaction[];

        if (rawTxs.length === 0) break;

        debugLog.push(`  Transactions page ${page}: ${rawTxs.length} items`);
        for (const tx of rawTxs) {
          const mov = biceTransactionToMovement(tx);
          if (mov) allMovements.push(mov);
        }

        page++;
        hasMore =
          res.hasMore === true ||
          (res.totalPages !== undefined && page <= res.totalPages);
      } catch {
        break;
      }
    }
  } catch (err) {
    debugLog.push(
      `  Transactions error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return allMovements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBice(
  options: ScraperOptions,
  debugLog: string[],
): Promise<ScrapeResult> {
  const { rut, password, onProgress, onTwoFactorCode } = options;
  const bank = "bice";
  const progress = onProgress || (() => {});

  // Login via Keycloak + OAuth agent
  progress("Conectando con BICE API...");
  const loginResult = await biceKeycloakLogin(
    rut,
    password,
    debugLog,
    onTwoFactorCode,
  );
  if (!loginResult.success) {
    return {
      success: false,
      bank,
      movements: [],
      error: loginResult.error,
      debug: debugLog.join("\n"),
    };
  }

  const { gwJar } = loginResult;
  progress("Sesion iniciada correctamente");

  // Fetch products (account list)
  debugLog.push("7. Fetching data via BFF endpoints...");
  progress("Obteniendo productos...");
  const products = await fetchProducts(gwJar, debugLog);
  debugLog.push(`  Found ${products.length} product(s)`);

  // Fetch balance
  progress("Obteniendo saldo...");
  const balance = await fetchBalance(gwJar, debugLog);

  // Fetch transactions (movements)
  progress("Extrayendo movimientos...");
  const movements = await fetchTransactions(gwJar, debugLog);
  debugLog.push(`  Raw movements: ${movements.length}`);

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`8. Total: ${deduplicated.length} unique movements`);
  progress(`Listo -- ${deduplicated.length} movimientos totales`);

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance: balance ?? undefined,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const bice: BankScraper = {
  id: "bice",
  name: "Banco BICE",
  url: PORTAL_URL,
  mode: "api",
  scrape: (options) => runApiScraper("bice", options, scrapeBice),
};

export default bice;
