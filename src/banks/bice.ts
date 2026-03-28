import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── BICE constants ─────────────────────────────────────────────
//
// Auth: Keycloak OIDC at auth.bice.cl/auth/realms/personas
// Flow: GET portal → redirect to Keycloak → parse <form action="..."> → POST credentials
//       → follow redirect chain back to portal with session cookies
// Data: REST API at portalpersonas.bice.cl (endpoints are best-guess, needs discovery)
//
// No browser needed — this scraper uses fetch() exclusively.

const PORTAL_URL = "https://portalpersonas.bice.cl";
const API_BASE = "https://portalpersonas.bice.cl/api";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

// ─── HTML parsing helpers ────────────────────────────────────────

/** Extract the Keycloak form action URL from the login page HTML */
function parseKeycloakFormAction(html: string): string | null {
  // Keycloak login form: <form id="kc-form-login" action="https://auth.bice.cl/auth/realms/...">
  const match = html.match(/<form[^>]*id=["']kc-form-login["'][^>]*action=["']([^"']+)["']/i)
    || html.match(/<form[^>]*action=["']([^"']+)["'][^>]*id=["']kc-form-login["']/i);
  if (match) return match[1].replace(/&amp;/g, "&");
  // Fallback: any form with action containing auth.bice.cl
  const fallback = html.match(/<form[^>]*action=["'](https?:\/\/auth\.bice\.cl[^"']+)["']/i);
  if (fallback) return fallback[1].replace(/&amp;/g, "&");
  return null;
}

/** Check if the HTML contains Keycloak error/feedback messages */
function parseKeycloakError(html: string): string | null {
  // Standard Keycloak error span
  const errorMatch = html.match(/<span[^>]*class=["'][^"']*kc-feedback-text[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (errorMatch) {
    const text = errorMatch[1].replace(/<[^>]+>/g, "").trim();
    if (text) return text;
  }
  // Alert div
  const alertMatch = html.match(/<div[^>]*class=["'][^"']*alert[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (alertMatch) {
    const text = alertMatch[1].replace(/<[^>]+>/g, "").trim();
    if (text) return text;
  }
  return null;
}

/** Detect 2FA indicators in Keycloak page */
function is2FAPage(html: string): boolean {
  const lower = html.toLowerCase();
  return lower.includes("otp") ||
    lower.includes("two-factor") ||
    lower.includes("segundo factor") ||
    lower.includes("verificaci") ||
    (lower.includes("code") && lower.includes("sms")) ||
    lower.includes("kc-form-otp") ||
    lower.includes("authenticator");
}

// ─── Login ───────────────────────────────────────────────────────

async function biceLogin(
  rut: string,
  password: string,
  debugLog: string[],
  onTwoFactorCode?: () => Promise<string>,
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  const jar = createCookieJar();

  // Step 1: GET portal — manually follow redirects to collect cookies at each hop
  debugLog.push("1. Fetching portal (triggers Keycloak redirect)...");
  let currentUrl: string = PORTAL_URL;
  let loginHtml = "";
  let maxHops = 15;
  while (maxHops-- > 0) {
    const res = await fetch(currentUrl, {
      headers: { "User-Agent": UA, "Cookie": jar.header() },
      redirect: "manual",
    });
    jar.setAll(res.headers);
    const location = res.headers.get("location");
    if (location) {
      currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).href;
      debugLog.push(`  Redirect: ${currentUrl.slice(0, 80)}...`);
      continue;
    }
    // Final destination — read HTML
    loginHtml = await res.text();
    debugLog.push(`  Landed: ${currentUrl.slice(0, 80)} (${res.status}), cookies: ${jar.cookies.size}`);
    break;
  }

  // Step 2: Parse Keycloak form action URL (contains session code)
  const formAction = parseKeycloakFormAction(loginHtml);
  if (!formAction) {
    debugLog.push("  ERROR: Could not find Keycloak form action in HTML");
    return { success: false, error: "No se encontro el formulario de login de Keycloak." };
  }
  debugLog.push(`2. Found Keycloak form action: ${formAction.substring(0, 80)}...`);

  // Step 3: POST credentials as form-urlencoded
  debugLog.push("3. Submitting credentials to Keycloak...");
  const cleanRut = rut.replace(/[.\-]/g, "");
  const body = new URLSearchParams({
    username: cleanRut,
    password: password,
  });

  const loginRes = await fetch(formAction, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
      Referer: currentUrl,
      Origin: "https://auth.bice.cl",
    },
    body: body.toString(),
    redirect: "manual",
  });
  jar.setAll(loginRes.headers);

  const location = loginRes.headers.get("location") || "";
  debugLog.push(`  Login response: ${loginRes.status}, Location: ${location.substring(0, 80)}`);

  // Status 200 = Keycloak sent back the login page (credentials wrong or 2FA)
  if (loginRes.status === 200) {
    const responseHtml = await loginRes.text();

    // Check for 2FA
    if (is2FAPage(responseHtml)) {
      debugLog.push("  2FA detected — requesting code...");
      if (!onTwoFactorCode) {
        return { success: false, error: "Se requiere codigo 2FA pero no hay callback configurado." };
      }

      const code = await onTwoFactorCode();
      debugLog.push("  Submitting 2FA code...");

      // Parse 2FA form action (may differ from login form)
      const otpFormAction = parseKeycloakFormAction(responseHtml) || formAction;
      const otpBody = new URLSearchParams({
        otp: code,
      });

      const otpRes = await fetch(otpFormAction, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: jar.header(),
          Referer: currentUrl,
          Origin: "https://auth.bice.cl",
        },
        body: otpBody.toString(),
        redirect: "manual",
      });
      jar.setAll(otpRes.headers);

      const otpLocation = otpRes.headers.get("location") || "";
      debugLog.push(`  2FA response: ${otpRes.status}, Location: ${otpLocation.substring(0, 80)}`);

      if (otpRes.status === 200) {
        const otpHtml = await otpRes.text();
        const otpError = parseKeycloakError(otpHtml);
        return { success: false, error: `Error 2FA: ${otpError || "Codigo incorrecto"}` };
      }

      // Follow redirect chain after 2FA
      if (otpRes.status >= 300 && otpRes.status < 400 && otpLocation) {
        return await followRedirectChain(jar, otpLocation, debugLog);
      }
    }

    // Check for login error
    const loginError = parseKeycloakError(responseHtml);
    return { success: false, error: `Credenciales incorrectas: ${loginError || "RUT o clave invalida."}` };
  }

  // Status 302/303 = success, follow redirect chain
  if (loginRes.status >= 300 && loginRes.status < 400 && location) {
    return await followRedirectChain(jar, location, debugLog);
  }

  return { success: false, error: `Respuesta inesperada de Keycloak: ${loginRes.status}` };
}

/** Follow the Keycloak redirect chain back to the portal */
async function followRedirectChain(
  jar: CookieJar,
  initialLocation: string,
  debugLog: string[],
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  debugLog.push("4. Following redirect chain to portal...");
  let url = initialLocation;
  let hops = 0;
  const MAX_HOPS = 10;

  while (hops < MAX_HOPS) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Cookie: jar.header() },
      redirect: "manual",
    });
    jar.setAll(res.headers);

    const nextLocation = res.headers.get("location") || "";
    debugLog.push(`  Hop ${hops + 1}: ${res.status} ${url.substring(0, 60)}...`);

    if (res.status >= 300 && res.status < 400 && nextLocation) {
      url = nextLocation.startsWith("http") ? nextLocation : new URL(nextLocation, url).href;
      hops++;
      continue;
    }

    // We've landed (200 response)
    if (res.status === 200) {
      // If we're on the portal, login succeeded
      if (url.includes("portalpersonas.bice.cl")) {
        debugLog.push(`5. Login OK! Cookies: ${Array.from(jar.cookies.keys()).join(", ")}`);
        return { success: true, jar };
      }
      // If we're still on auth.bice.cl, something went wrong
      if (url.includes("auth.bice.cl")) {
        return { success: false, error: "Redireccion termino en Keycloak — login posiblemente fallido." };
      }
    }

    break;
  }

  // Final attempt: GET the portal directly with collected cookies
  debugLog.push("5. Final: GETting portal with session cookies...");
  const portalRes = await fetch(PORTAL_URL, {
    headers: { "User-Agent": UA, Cookie: jar.header() },
    redirect: "follow",
  });
  jar.setAll(portalRes.headers);

  if (portalRes.url.includes("auth.bice.cl")) {
    return { success: false, error: "Sesion no establecida — redirigido de vuelta a Keycloak." };
  }

  debugLog.push(`  Portal OK: ${portalRes.status}, cookies: ${jar.cookies.size}`);
  return { success: true, jar };
}

// ─── API helpers ─────────────────────────────────────────────────

async function apiGet<T>(jar: CookieJar, path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: PORTAL_URL,
      Origin: "https://portalpersonas.bice.cl",
    },
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API GET ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(jar: CookieJar, path: string, body: unknown = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      Referer: PORTAL_URL,
      Origin: "https://portalpersonas.bice.cl",
    },
    body: JSON.stringify(body),
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API POST ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

/** Try multiple candidate URLs, return the first that succeeds */
async function tryEndpoints<T>(jar: CookieJar, candidates: string[], debugLog: string[]): Promise<T | null> {
  for (const path of candidates) {
    try {
      const result = await apiGet<T>(jar, path);
      debugLog.push(`    OK: ${path}`);
      return result;
    } catch {
      debugLog.push(`    Skip: ${path}`);
    }
  }
  return null;
}

// ─── API response types (best-guess, needs validation with real data) ──

interface BiceAccount {
  numero?: string;
  mascara?: string;
  tipo?: string;
  moneda?: string;
  saldo?: number;
  saldoDisponible?: number;
  nombre?: string;
  producto?: string;
}

interface BiceMovement {
  fecha?: string;
  fechaContable?: string;
  descripcion?: string;
  glosa?: string;
  monto?: number;
  cargo?: number;
  abono?: number;
  saldo?: number;
  tipo?: string;
}

interface BiceBalanceResponse {
  saldo?: number;
  saldoDisponible?: number;
  saldoContable?: number;
  disponible?: number;
  cuentas?: BiceAccount[];
}

interface BiceMovementsResponse {
  movimientos?: BiceMovement[];
  transacciones?: BiceMovement[];
  data?: BiceMovement[];
  content?: BiceMovement[];
}

// ─── Data extraction ─────────────────────────────────────────────

function biceMovToMovement(mov: BiceMovement): BankMovement | null {
  const dateStr = mov.fecha || mov.fechaContable || "";
  if (!dateStr) return null;

  const description = (mov.descripcion || mov.glosa || "").trim();
  if (!description) return null;

  let amount: number;
  if (mov.monto !== undefined) {
    amount = mov.monto;
  } else if (mov.cargo !== undefined && mov.cargo > 0) {
    amount = -Math.abs(mov.cargo);
  } else if (mov.abono !== undefined && mov.abono > 0) {
    amount = Math.abs(mov.abono);
  } else {
    return null;
  }

  // If type indicates "cargo" (debit), ensure amount is negative
  if (mov.tipo?.toLowerCase().includes("cargo") && amount > 0) {
    amount = -amount;
  }

  return {
    date: normalizeDate(dateStr),
    description,
    amount,
    balance: mov.saldo ?? 0,
    source: MOVEMENT_SOURCE.account,
  };
}

async function fetchBalance(jar: CookieJar, debugLog: string[]): Promise<number | undefined> {
  debugLog.push("  Trying balance endpoints...");

  // Candidate balance endpoints (best-guess, will need Chrome DevTools discovery)
  const balanceCandidates = [
    "cuentas/saldos",
    "cuentas/saldo",
    "productos/cuentas/saldos",
    "productos/saldos",
    "saldos",
    "cuenta-corriente/saldo",
    "v1/cuentas/saldos",
    "resumen/saldos",
    "dashboard/saldos",
  ];

  const result = await tryEndpoints<BiceBalanceResponse>(jar, balanceCandidates, debugLog);
  if (!result) return undefined;

  // Try to extract balance from various response shapes
  if (result.saldoDisponible !== undefined) return result.saldoDisponible;
  if (result.saldo !== undefined) return result.saldo;
  if (result.disponible !== undefined) return result.disponible;
  if (result.saldoContable !== undefined) return result.saldoContable;

  // If response has an array of accounts, find CLP account
  if (result.cuentas?.length) {
    const clp = result.cuentas.find(c => !c.moneda || c.moneda === "CLP");
    if (clp) return clp.saldoDisponible ?? clp.saldo;
  }

  return undefined;
}

async function fetchMovements(jar: CookieJar, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push("  Trying movement endpoints...");

  // Candidate movement endpoints (best-guess, will need Chrome DevTools discovery)
  const movementCandidates = [
    "movimientos",
    "cuentas/movimientos",
    "cuenta-corriente/movimientos",
    "productos/cuentas/movimientos",
    "v1/movimientos",
    "cartola/movimientos",
    "transacciones",
    "movimientos/ultimos",
    "dashboard/movimientos",
  ];

  const result = await tryEndpoints<BiceMovementsResponse>(jar, movementCandidates, debugLog);
  if (!result) return [];

  // Try to extract movements from various response shapes
  const rawMovements = result.movimientos || result.transacciones || result.data || result.content || [];
  const movements: BankMovement[] = [];

  for (const mov of rawMovements) {
    const converted = biceMovToMovement(mov);
    if (converted) movements.push(converted);
  }

  return movements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBice(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress, onTwoFactorCode } = options;
  const bank = "bice";
  const progress = onProgress || (() => {});

  // Login
  progress("Conectando con BICE API...");
  const loginResult = await biceLogin(rut, password, debugLog, onTwoFactorCode);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar } = loginResult;
  progress("Sesion iniciada correctamente");

  // Fetch balance
  debugLog.push("6. Fetching balance via API...");
  progress("Obteniendo saldo...");
  const balance = await fetchBalance(jar, debugLog);
  if (balance !== undefined) {
    debugLog.push(`  Balance: $${balance.toLocaleString("es-CL")}`);
  } else {
    debugLog.push("  Balance: not found (API endpoints need discovery)");
  }

  // Fetch movements
  debugLog.push("7. Fetching movements via API...");
  progress("Extrayendo movimientos...");
  const movements = await fetchMovements(jar, debugLog);
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
