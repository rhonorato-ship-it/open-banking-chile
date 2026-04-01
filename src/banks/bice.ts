import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, deduplicateMovements, delay } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Constants ───────────────────────────────────────────────────

const KEYCLOAK_AUTH_URL =
  "https://auth.bice.cl/realms/personas/protocol/openid-connect/auth?" +
  "client_id=portal-personas&redirect_uri=https%3A%2F%2Fportalpersonas.bice.cl%2F" +
  "&response_type=code&scope=openid+profile";

const GW_BASE = "https://gw.bice.cl";
const OAUTH_AGENT = `${GW_BASE}/oauth-agent-personas`;
const BFF_BASE = `${GW_BASE}/portalpersonas`;
const PORTAL_ORIGIN = "https://portalpersonas.bice.cl";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const TX_PAGE_SIZE = 40;
const MAX_TX_PAGES = 25;

// ─── Cookie jar ──────────────────────────────────────────────────

interface CookieJar {
  cookies: Map<string, string>;
  set(raw: string): void;
  setAll(h: Headers): void;
  header(): string;
  toJSON(): string;
}

function createCookieJar(initial?: Record<string, string>): CookieJar {
  const cookies = new Map<string, string>(initial ? Object.entries(initial) : []);
  return {
    cookies,
    set(raw: string) {
      const [nv] = raw.split(";");
      const eq = nv.indexOf("=");
      if (eq > 0) cookies.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
    },
    setAll(h: Headers) { for (const raw of h.getSetCookie?.() ?? []) this.set(raw); },
    header() { return [...cookies].map(([k, v]) => `${k}=${v}`).join("; "); },
    toJSON() { return JSON.stringify(Object.fromEntries(cookies)); },
  };
}

// ─── Types ───────────────────────────────────────────────────────

interface BiceTx { fecha?: string; fechaSinFormato?: string; descripcion?: string; narrativa?: string; monto?: string; tipo?: string; [k: string]: unknown }
interface BiceTxResp { movimientos?: BiceTx[]; paginacion?: { totalPaginas?: number }; [k: string]: unknown }
interface BiceBalResp { monto?: string; saldoDisponibleMonto?: string; [k: string]: unknown }
interface BiceProdResp { productos?: Array<{ tipo?: string; numero?: string; nombre?: string }>; [k: string]: unknown }

// ─── Parsing ─────────────────────────────────────────────────────

function parseTx(tx: BiceTx): BankMovement | null {
  let dateStr = "";
  if (tx.fechaSinFormato && /^\d{8}$/.test(tx.fechaSinFormato)) {
    const s = tx.fechaSinFormato;
    dateStr = `${s.slice(6)}-${s.slice(4, 6)}-${s.slice(0, 4)}`;
  } else if (tx.fecha) dateStr = normalizeDate(tx.fecha);
  if (!dateStr) return null;

  const desc = (tx.narrativa || tx.descripcion || "").trim();
  const raw = parseInt(tx.monto || "0", 10);
  if (!desc || !raw) return null;

  const amount = (tx.tipo || "").toLowerCase() === "cargo" ? -Math.abs(raw) : Math.abs(raw);
  return { date: dateStr, description: desc, amount, balance: 0, source: MOVEMENT_SOURCE.account };
}

// ─── HTTP helpers ────────────────────────────────────────────────

function gwHeaders(jar: CookieJar): Record<string, string> {
  return { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", Cookie: jar.header(), Origin: PORTAL_ORIGIN, Referer: `${PORTAL_ORIGIN}/` };
}

async function bffPost<T>(jar: CookieJar, path: string, body: unknown, log: string[]): Promise<T> {
  const res = await fetch(`${BFF_BASE}/${path}`, { method: "POST", headers: gwHeaders(jar), body: JSON.stringify(body), redirect: "follow" });
  jar.setAll(res.headers);
  if (!res.ok) { log.push(`BFF ${path} -> ${res.status}`); throw new Error(`BFF ${path} -> ${res.status}`); }
  return res.json() as Promise<T>;
}

// ─── Keycloak HTTP login ─────────────────────────────────────────

type LoginOk = { success: true; jar: CookieJar };
type LoginFail = { success: false; error: string; cloudflareBlocked?: boolean };

async function keycloakHttpLogin(rut: string, password: string, log: string[]): Promise<LoginOk | LoginFail> {
  const jar = createCookieJar();
  log.push("1. Fetching Keycloak login page via HTTP...");

  // Step 1: GET login page
  const authRes = await fetch(KEYCLOAK_AUTH_URL, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
  jar.setAll(authRes.headers);
  const cfBlocked = authRes.headers.get("cf-mitigated") === "challenge" || authRes.status === 403;
  if (cfBlocked) { log.push(`  Cloudflare challenge detected (status=${authRes.status}, cf-mitigated=${authRes.headers.get("cf-mitigated")})`); return { success: false, error: "Cloudflare challenge", cloudflareBlocked: true }; }
  if (!authRes.ok) return { success: false, error: `Keycloak page returned ${authRes.status}` };

  const html = await authRes.text();
  const actionMatch = html.match(/action="([^"]+)"/);
  if (!actionMatch) {
    if (html.includes("cf-challenge") || html.includes("turnstile")) return { success: false, error: "Cloudflare challenge page", cloudflareBlocked: true };
    return { success: false, error: "No form action found in Keycloak page" };
  }
  const formAction = actionMatch[1].replace(/&amp;/g, "&");

  // Step 2: POST credentials
  log.push("2. Submitting credentials to Keycloak...");
  const loginRes = await fetch(formAction, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header(), Referer: authRes.url },
    body: new URLSearchParams({ username: formatRut(rut), password }).toString(),
    redirect: "manual",
  });
  jar.setAll(loginRes.headers);

  // Check credential error (Keycloak returns 200 on bad credentials)
  if (loginRes.status === 200) {
    const body = await loginRes.text();
    if (body.includes("kc-feedback-text") || body.includes("Invalid username or password") || body.includes("credenciales"))
      return { success: false, error: "Credenciales incorrectas (RUT o clave invalida)." };
    if (body.includes("otp") || body.includes("two-factor") || body.includes("segundo factor") || body.includes("kc-form-otp"))
      return { success: false, error: "Se requiere 2FA. Use modo browser para 2FA." };
    return { success: false, error: "Respuesta inesperada del servidor." };
  }

  if (loginRes.status !== 302 && loginRes.status !== 303)
    return { success: false, error: `Keycloak returned ${loginRes.status}` };

  // Step 3: Follow redirect chain to get auth code
  let location = loginRes.headers.get("location") || "";
  for (let i = 0; i < 10 && location; i++) {
    const r = await fetch(location, { headers: { "User-Agent": UA, Cookie: jar.header() }, redirect: "manual" });
    jar.setAll(r.headers);
    location = r.headers.get("location") || "";
    if (!location || r.status < 300 || r.status >= 400) break;
  }

  // Step 4: Extract auth code or check for existing session
  const codeMatch = location.match(/[?&]code=([^&]+)/);
  if (!codeMatch) {
    if ([...jar.cookies.keys()].some(k => k.includes("AT") || k.includes("RT") || k.includes("session"))) {
      log.push("3. Login OK (session cookies found)");
      return { success: true, jar };
    }
    return { success: false, error: "No auth code from Keycloak." };
  }

  // Step 5: OAuth agent exchange
  log.push("3. OAuth agent login/start...");
  const startRes = await fetch(`${OAUTH_AGENT}/login/start`, {
    method: "POST", headers: gwHeaders(jar),
    body: JSON.stringify({ pageUrl: `${PORTAL_ORIGIN}/?code=${codeMatch[1]}` }), redirect: "follow",
  });
  jar.setAll(startRes.headers);
  if (!startRes.ok) return { success: false, error: `oauth-agent login/start failed: ${startRes.status}` };

  log.push("4. OAuth agent login/end...");
  const endRes = await fetch(`${OAUTH_AGENT}/login/end`, {
    method: "POST", headers: gwHeaders(jar), body: "{}", redirect: "follow",
  });
  jar.setAll(endRes.headers);
  if (!endRes.ok) return { success: false, error: `oauth-agent login/end failed: ${endRes.status}` };

  // Optional userInfo verification
  const uiRes = await fetch(`${OAUTH_AGENT}/userInfo`, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: jar.header(), Origin: PORTAL_ORIGIN, Referer: `${PORTAL_ORIGIN}/` } });
  jar.setAll(uiRes.headers);
  log.push(uiRes.ok ? `5. userInfo OK` : `5. userInfo ${uiRes.status} (non-fatal)`);
  log.push(`6. Login OK via HTTP!`);
  return { success: true, jar };
}

// ─── Browser fallback login ──────────────────────────────────────

async function browserFallbackLogin(options: ScraperOptions, log: string[]): Promise<LoginOk | LoginFail> {
  log.push("--- Browser fallback login (Cloudflare blocked HTTP) ---");
  const { launchBrowser } = await import("../infrastructure/browser.js");
  const { rut, password, chromePath, headful, launchArgs, userDataDir, remoteCDP, onProgress, onTwoFactorCode } = options;
  const progress = onProgress || (() => {});

  const session = await launchBrowser({ chromePath, headful, launchArgs, userDataDir, remoteCDP }, !!options.saveScreenshots);
  try {
    const { page } = session;

    // Navigate + wait for login form
    log.push("B1. Navigating to Keycloak...");
    await page.goto(KEYCLOAK_AUTH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await delay(1000);

    log.push("B2. Waiting for #username field...");
    let found = await page.waitForSelector("#username", { timeout: 30_000 }).catch(() => null);
    if (!found) {
      for (let t = Date.now(); Date.now() - t < 30_000; await delay(2000))
        if (await page.$("#username")) { found = true as any; break; }
      if (!found) return { success: false, error: "Login form not found (browser)." };
    }

    // Fill + submit
    log.push("B3. Entering credentials...");
    await page.type("#username", formatRut(rut), { delay: 60 });
    await delay(300);
    await page.waitForSelector("#password", { timeout: 5_000 });
    await page.type("#password", password, { delay: 60 });
    log.push("B4. Submitting login...");
    progress("Autenticando...");
    const btn = await page.$("#kc-login");
    btn ? await btn.click() : await page.keyboard.press("Enter");
    try { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }); } catch { await delay(5000); }

    const postUrl = page.url();
    log.push(`  Post-login URL: ${postUrl}`);

    // Handle 2FA or credential error
    if (postUrl.includes("auth.bice.cl")) {
      const html = (await page.content()).toLowerCase();
      const is2FA = ["otp", "two-factor", "segundo factor", "verificaci", "authenticator", "kc-form-otp"].some(kw => html.includes(kw));
      if (is2FA) {
        log.push("  2FA detected");
        progress("Esperando codigo de verificacion...");
        if (!onTwoFactorCode) return { success: false, error: "Se requiere codigo 2FA pero no hay callback configurado." };
        const code = await onTwoFactorCode();
        if (!code) return { success: false, error: "No se recibio codigo 2FA." };

        const otpInput = (await page.$("#otp")) || (await page.$("input[name='otp']")) || (await page.$("input[name='totp']"));
        if (otpInput) await otpInput.fill(code);
        else { const inputs = await page.$$("input[type='text'], input[type='number'], input:not([type])"); if (inputs.length) await inputs[0].type(code, { delay: 60 }); }
        const sub = (await page.$("#kc-login")) || (await page.$("input[type='submit']"));
        if (sub) await sub.click();
        try { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }); } catch { await delay(5000); }
        if (page.url().includes("auth.bice.cl")) return { success: false, error: "Codigo 2FA incorrecto o expirado." };
      } else {
        const errEl = await page.$(".kc-feedback-text, [class*='alert'], [class*='error']");
        const errTxt = errEl ? await errEl.innerText().catch(() => "") : "";
        return { success: false, error: `Credenciales incorrectas: ${errTxt || "RUT o clave invalida."}` };
      }
    }

    // Extract cookies from browser
    log.push("B5. Extracting cookies...");
    await delay(3000);
    const browserCookies = await session.context.cookies(["https://gw.bice.cl", "https://portalpersonas.bice.cl"]);
    const jar = createCookieJar();
    for (const c of browserCookies) jar.cookies.set(c.name, c.value);
    if (jar.cookies.size === 0) return { success: false, error: "No session cookies from browser." };
    log.push(`B6. Browser login OK! Cookies: ${[...jar.cookies.keys()].join(", ")}`);
    return { success: true, jar };
  } finally {
    await session.browser.close().catch(() => {});
  }
}

// ─── Data fetching ───────────────────────────────────────────────

async function fetchBalance(jar: CookieJar, log: string[]): Promise<number | undefined> {
  try {
    const d = await bffPost<BiceBalResp>(jar, "bff-checking-account-transactions-100/v1/balance", {}, log);
    const raw = d?.saldoDisponibleMonto || d?.monto;
    if (raw) { const b = parseInt(raw, 10); log.push(`  Balance: $${b.toLocaleString("es-CL")}`); return b; }
  } catch (e) { log.push(`  Balance failed: ${e instanceof Error ? e.message : e}`); }
  return undefined;
}

async function fetchTransactions(jar: CookieJar, log: string[]): Promise<BankMovement[]> {
  const movs: BankMovement[] = [];
  for (let p = 1; p <= MAX_TX_PAGES; p++) {
    try {
      const d = await bffPost<BiceTxResp>(jar, "bff-checking-account-transactions-100/v1/transactions", { pagina: p, tamanioPagina: TX_PAGE_SIZE }, log);
      const raw = d?.movimientos || [];
      if (!raw.length) break;
      for (const tx of raw) { const m = parseTx(tx); if (m) movs.push(m); }
      if (p >= (d?.paginacion?.totalPaginas || 1) || raw.length < TX_PAGE_SIZE) break;
    } catch { break; }
  }
  return movs;
}

// ─── Main ────────────────────────────────────────────────────────

async function scrapeBice(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const bank = "bice";
  const progress = onProgress || (() => {});

  progress("Conectando con BICE API...");
  let loginResult = await keycloakHttpLogin(rut, password, debugLog);

  // Cloudflare fallback to browser
  if (!loginResult.success && "cloudflareBlocked" in loginResult && loginResult.cloudflareBlocked) {
    debugLog.push("--- Cloudflare blocked, falling back to browser ---");
    progress("Cloudflare detectado, usando navegador...");
    if (!options.remoteCDP && !options.chromePath && !options.headful) {
      const { findChrome } = await import("../utils.js");
      if (!findChrome()) {
        const isVercel = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
        return { success: false, bank, movements: [], debug: debugLog.join("\n"),
          error: isVercel ? "Cloudflare bloquea BICE. Usa el agente local: npx open-banking-chile serve" : "Cloudflare bloquea BICE. Instala Chrome o usa --headful --profile." };
      }
    }
    loginResult = await browserFallbackLogin(options, debugLog);
  }

  if (!loginResult.success) return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  const { jar } = loginResult;
  progress("Sesion iniciada");

  // Fetch data
  debugLog.push("7. Fetching data...");
  progress("Extrayendo movimientos...");
  try { await bffPost<BiceProdResp>(jar, "bff-portal-hbp/v1/products", {}, debugLog); } catch {}
  const [balance, movements] = await Promise.all([fetchBalance(jar, debugLog), fetchTransactions(jar, debugLog)]);
  const deduped = deduplicateMovements(movements);
  debugLog.push(`9. Total: ${deduped.length} movements`);
  progress(`Listo - ${deduped.length} movimientos`);

  return { success: true, bank, movements: deduped, balance, sessionCookies: jar.toJSON(), debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const bice: BankScraper = { id: "bice", name: "Banco BICE", url: PORTAL_ORIGIN, mode: "api",
  scrape: (options) => runApiScraper("bice", options, scrapeBice, 60_000) };
export default bice;
