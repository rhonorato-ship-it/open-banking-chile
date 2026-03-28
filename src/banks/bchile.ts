import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { formatRut, normalizeDate, deduplicateMovements, normalizeInstallments } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Banco de Chile constants ────────────────────────────────────
//
// Auth: Spring Security form-login at login.portal.bancochile.cl
// Data: REST API at portalpersonas.bancochile.cl/mibancochile/rest/persona
// CSRF: Angular double-submit cookie (XSRF-TOKEN cookie + X-XSRF-TOKEN header)
//
// No browser needed — this scraper uses fetch() exclusively.

const LOGIN_PAGE = "https://login.portal.bancochile.cl/bancochile-web/persona/login/index.html";
const LOGIN_POST = "https://login.portal.bancochile.cl/bancochile-web/persona/login/index.html";
const PORTAL_URL = "https://portalpersonas.bancochile.cl/persona/";
const API_BASE = "https://portalpersonas.bancochile.cl/mibancochile/rest/persona";
const MONTH_NAMES = ["", "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ─── API types ───────────────────────────────────────────────────

interface ApiProduct { id: string; numero: string; mascara: string; codigo: string; codigoMoneda: string; label: string; tipo: string; claseCuenta: string; tarjetaHabiente: string | null; descripcionLogo: string; tipoCliente: string; }
interface ApiCardInfo { titular: boolean; marca: string; tipo: string; idProducto: string; numero: string; }
interface ApiCardSaldo { cupoTotalNacional: number; cupoUtilizadoNacional: number; cupoDisponibleNacional: number; cupoTotalInternacional: number; cupoUtilizadoInternacional: number; cupoDisponibleInternacional: number; }
interface ApiMovNoFactur { origenTransaccion: string; fechaTransaccionString: string; montoCompra: number; glosaTransaccion: string; despliegueCuotas: string; }
interface ApiFechaFacturacion { fechaFacturacion: string; existeEstadoCuentaNacional: string; existeEstadoCuentaInternacional: string; }
interface ApiTransaccionFacturada { fechaTransaccionString: string; montoTransaccion: number; descripcion: string; cuotas: string; grupo: string; }
interface ApiCartolaMov { descripcion: string; monto: number; saldo: number; tipo: string; fechaContable: string; }
type ApiCartolaResponse = { movimientos: ApiCartolaMov[]; pagina: Array<{ totalRegistros: number; masPaginas: boolean }> };

// ─── Cookie jar ──────────────────────────────────────────────────

interface CookieJar {
  cookies: Map<string, string>;
  set(raw: string): void;
  setAll(headers: Headers): void;
  header(): string;
  xsrf(): string;
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
      // getSetCookie() returns all Set-Cookie headers as an array
      const setCookies = headers.getSetCookie?.() ?? [];
      for (const raw of setCookies) this.set(raw);
    },
    header() {
      return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    },
    xsrf() {
      return decodeURIComponent(cookies.get("XSRF-TOKEN") ?? "");
    },
  };
}

// ─── Login ───────────────────────────────────────────────────────

async function bchileLogin(
  rut: string,
  password: string,
  debugLog: string[],
): Promise<{ success: true; jar: CookieJar } | { success: false; error: string }> {
  const jar = createCookieJar();

  // Step 1: GET login page to collect pre-auth cookies (XSRF-TOKEN)
  debugLog.push("1. Fetching login page...");
  const loginPageRes = await fetch(LOGIN_PAGE, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  jar.setAll(loginPageRes.headers);
  debugLog.push(`  Status: ${loginPageRes.status}, cookies: ${jar.cookies.size}`);

  // Step 2: POST credentials — Spring Security form-login
  debugLog.push("2. Submitting credentials...");
  const formattedRut = formatRut(rut);
  const body = new URLSearchParams({
    userRut: formattedRut,
    userPassword: password,
  });
  // Include CSRF token if present
  const xsrf = jar.xsrf();
  if (xsrf) body.set("_csrf", xsrf);

  const loginRes = await fetch(LOGIN_POST, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
      Referer: LOGIN_PAGE,
      ...(xsrf ? { "X-XSRF-TOKEN": xsrf } : {}),
    },
    body: body.toString(),
    redirect: "manual",
  });
  jar.setAll(loginRes.headers);

  const location = loginRes.headers.get("location") || "";
  debugLog.push(`  Login response: ${loginRes.status}, Location: ${location}`);

  // Check for login failure
  if (loginRes.status === 200 || location.includes("/login")) {
    // 200 = Spring sent back the login page (credentials wrong)
    // 302 to /login = also failure
    return { success: false, error: "Credenciales incorrectas (RUT o clave inválida)." };
  }

  // Step 3: Follow redirect to portal to get portal-scoped cookies
  debugLog.push("3. Following redirect to portal...");
  const redirectUrl = location.startsWith("http") ? location : `https://login.portal.bancochile.cl${location}`;
  const portalRes = await fetch(redirectUrl, {
    headers: { "User-Agent": UA, Cookie: jar.header() },
    redirect: "follow",
  });
  jar.setAll(portalRes.headers);

  // Step 4: GET the portal page to ensure XSRF-TOKEN is set for API domain
  const portalPageRes = await fetch(PORTAL_URL, {
    headers: { "User-Agent": UA, Cookie: jar.header() },
    redirect: "follow",
  });
  jar.setAll(portalPageRes.headers);

  // Verify we have the required cookies
  if (!jar.cookies.has("XSRF-TOKEN")) {
    return { success: false, error: "Login pareció exitoso pero no se obtuvo XSRF-TOKEN." };
  }

  debugLog.push(`4. Login OK! Cookies: ${Array.from(jar.cookies.keys()).join(", ")}`);
  return { success: true, jar };
}

// ─── API helpers ─────────────────────────────────────────────────

async function apiGet<T>(jar: CookieJar, path: string): Promise<T> {
  const url = `${API_BASE}/${path}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Cookie: jar.header(),
      "X-XSRF-TOKEN": jar.xsrf(),
      Referer: PORTAL_URL,
      Origin: "https://portalpersonas.bancochile.cl",
    },
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function apiPost<T>(jar: CookieJar, path: string, body: unknown = {}): Promise<T> {
  const url = `${API_BASE}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: jar.header(),
      "X-XSRF-TOKEN": jar.xsrf(),
      Referer: PORTAL_URL,
      Origin: "https://portalpersonas.bancochile.cl",
    },
    body: JSON.stringify(body),
  });
  jar.setAll(res.headers);
  if (!res.ok) throw new Error(`API POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Data extraction ─────────────────────────────────────────────

function cartolaMovToMovement(mov: ApiCartolaMov): BankMovement {
  return { date: normalizeDate(mov.fechaContable), description: mov.descripcion.trim(), amount: mov.tipo === "cargo" ? -Math.abs(mov.monto) : Math.abs(mov.monto), balance: mov.saldo, source: MOVEMENT_SOURCE.account };
}

function facturadoToMovement(tx: ApiTransaccionFacturada, source: MovementSource): BankMovement {
  return { date: normalizeDate(tx.fechaTransaccionString), description: tx.descripcion.trim(), amount: tx.grupo === "pagos" ? Math.abs(tx.montoTransaccion) : -Math.abs(tx.montoTransaccion), balance: 0, source, installments: normalizeInstallments(tx.cuotas) };
}

async function fetchAccountMovements(jar: CookieJar, products: ApiProduct[], fullName: string, rut: string, debugLog: string[]): Promise<{ movements: BankMovement[]; balance?: number }> {
  const accounts = products.filter(p => p.tipo === "cuenta" || p.tipo === "cuentaCorrienteMonedaLocal");
  const seenNums = new Set<string>();
  const unique = accounts.filter(a => { if (seenNums.has(a.numero)) return false; seenNums.add(a.numero); return true; });
  if (unique.length === 0) return { movements: [] };

  const movements: BankMovement[] = [];
  let balance: number | undefined;

  for (const acct of unique) {
    debugLog.push(`  Fetching ${acct.descripcionLogo} ${acct.mascara}`);
    const cuentaSeleccionada = { nombreCliente: fullName, rutCliente: rut, numero: acct.numero, mascara: acct.mascara, selected: true, codigoProducto: acct.codigo, claseCuenta: acct.claseCuenta, moneda: acct.codigoMoneda };

    try {
      await apiPost(jar, "movimientos/getConfigConsultaMovimientos", { cuentasSeleccionadas: [cuentaSeleccionada] });
      const cartola = await apiPost<ApiCartolaResponse>(jar, "bff-pper-prd-cta-movimientos/movimientos/getCartola", { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: 1 } });

      if (cartola.movimientos) {
        for (const mov of cartola.movimientos) movements.push(cartolaMovToMovement(mov));
        if (balance === undefined && acct.codigoMoneda === "CLP" && cartola.movimientos.length > 0) balance = cartola.movimientos[0].saldo;

        let hasMore = cartola.movimientos.length > 0 && (cartola.pagina?.[0]?.masPaginas ?? false);
        let offset = 1 + cartola.movimientos.length;
        for (let p = 2; hasMore && p <= 25; p++) {
          try {
            const next = await apiPost<ApiCartolaResponse>(jar, "bff-pper-prd-cta-movimientos/movimientos/getCartola", { cuentaSeleccionada, cabecera: { statusGenerico: true, paginacionDesde: offset } });
            if (!next.movimientos?.length) break;
            for (const mov of next.movimientos) movements.push(cartolaMovToMovement(mov));
            offset += next.movimientos.length;
            hasMore = next.pagina?.[0]?.masPaginas ?? false;
          } catch { hasMore = false; }
        }
      }
    } catch (err) { debugLog.push(`    → Error: ${err instanceof Error ? err.message : String(err)}`); }
  }

  return { movements, balance };
}

async function fetchCreditCardData(jar: CookieJar, fullName: string, debugLog: string[]): Promise<{ movements: BankMovement[]; creditCards: CreditCardBalance[] }> {
  const movements: BankMovement[] = [];
  const creditCards: CreditCardBalance[] = [];

  let cards: ApiCardInfo[];
  try { cards = await apiPost<ApiCardInfo[]>(jar, "tarjetas/widget/informacion-tarjetas", {}); } catch { return { movements, creditCards }; }
  if (cards.length === 0) return { movements, creditCards };

  debugLog.push(`  Found ${cards.length} credit card(s)`);

  for (const card of cards) {
    const cardLabel = `${card.marca} ${card.tipo} ${card.numero.slice(-8)}`.trim();
    const mascara = card.numero.replace(/\*/g, "").length <= 4 ? `****${card.numero.slice(-4)}` : card.numero;
    const baseBody = { idTarjeta: card.idProducto, codigoProducto: "TNM", tipoTarjeta: `${card.marca} ${card.tipo}`.trim(), mascara, nombreTitular: fullName };
    const body = { ...baseBody, tipoCliente: "T" as const };

    const [saldoResult, noFactResult] = await Promise.allSettled([
      apiPost<ApiCardSaldo>(jar, "tarjeta-credito-digital/saldo/obtener-saldo", body),
      apiPost<{ fechaProximaFacturacionCalendario: string; listaMovNoFactur: ApiMovNoFactur[] }>(jar, "tarjeta-credito-digital/movimientos-no-facturados", body),
    ]);

    if (saldoResult.status === "fulfilled") {
      const s = saldoResult.value;
      creditCards.push({ label: cardLabel, national: { used: s.cupoUtilizadoNacional, available: s.cupoDisponibleNacional, total: s.cupoTotalNacional }, international: { used: s.cupoUtilizadoInternacional, available: s.cupoDisponibleInternacional, total: s.cupoTotalInternacional, currency: "USD" } });
    } else { creditCards.push({ label: cardLabel }); }

    if (noFactResult.status === "fulfilled") {
      const nf = noFactResult.value;
      const ccEntry = creditCards[creditCards.length - 1];
      if (nf.fechaProximaFacturacionCalendario) ccEntry.nextBillingDate = nf.fechaProximaFacturacionCalendario;
      for (const mov of nf.listaMovNoFactur || []) {
        const amount = mov.montoCompra < 0 ? Math.abs(mov.montoCompra) : -Math.abs(mov.montoCompra);
        movements.push({ date: normalizeDate(mov.fechaTransaccionString), description: mov.glosaTransaccion.trim(), amount, balance: 0, source: MOVEMENT_SOURCE.credit_card_unbilled, installments: normalizeInstallments(mov.despliegueCuotas) });
      }
    }

    // Facturados
    try {
      const fechas = await apiPost<{ existenEstadosDeCuenta: boolean; numeroCuenta: string | null; listaNacional: ApiFechaFacturacion[]; listaInternacional: ApiFechaFacturacion[] }>(jar, "tarjetas/estadocuenta/fechas-facturacion", baseBody);
      if (fechas.existenEstadosDeCuenta) {
        const ccEntry = creditCards[creditCards.length - 1];
        if (fechas.listaNacional?.[0]) {
          const parts = fechas.listaNacional[0].fechaFacturacion.split("-");
          if (parts.length >= 2) {
            const mi = parseInt(parts[1], 10);
            if (Number.isFinite(mi) && mi >= 1 && mi <= 12) {
              ccEntry.billingPeriod = `${MONTH_NAMES[mi]} ${parts[0]}`;
            } else {
              ccEntry.billingPeriod = `${parts[1]} ${parts[0]}`;
            }
          }
        }
        const latestFecha = fechas.listaNacional?.[0]?.fechaFacturacion;
        const numeroCuenta = fechas.numeroCuenta;
        if (latestFecha && numeroCuenta) {
          const resumenBody = { ...baseBody, fechaFacturacion: latestFecha, numeroCuenta };
          const [nacR, intR] = await Promise.allSettled([
            apiPost<{ existeEstadoCuenta: boolean; seccionOperaciones?: { transaccionesTarjetas: ApiTransaccionFacturada[] } }>(jar, "tarjetas/estadocuenta/nacional/resumen-por-fecha", resumenBody),
            apiPost<{ existeEstadoCuenta: boolean; seccionOperaciones?: { transaccionesTarjetas: ApiTransaccionFacturada[] } }>(jar, "tarjetas/estadocuenta/internacional/resumen-por-fecha", resumenBody),
          ]);
          for (const r of [nacR, intR]) {
            if (r.status === "fulfilled" && r.value.existeEstadoCuenta) {
              for (const tx of r.value.seccionOperaciones?.transaccionesTarjetas ?? []) {
                if (tx.grupo === "totales") continue;
                movements.push(facturadoToMovement(tx, MOVEMENT_SOURCE.credit_card_billed));
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  return { movements, creditCards };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeBchile(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut, password, onProgress } = options;
  const bank = "bchile";
  const progress = onProgress || (() => {});

  progress("Conectando con Banco de Chile API...");
  const loginResult = await bchileLogin(rut, password, debugLog);
  if (!loginResult.success) {
    return { success: false, bank, movements: [], error: loginResult.error, debug: debugLog.join("\n") };
  }

  const { jar } = loginResult;
  progress("Sesión iniciada correctamente");

  // Fetch products & client data
  debugLog.push("5. Fetching products and client data via API...");
  progress("Obteniendo productos y datos del cliente...");
  let products: { rut: string; nombre: string; productos: ApiProduct[] };
  let clientData: { datosCliente: { rut: string; nombres: string; apellidoPaterno: string; apellidoMaterno: string } };
  try {
    [products, clientData] = await Promise.all([
      apiGet<typeof products>(jar, "selectorproductos/selectorProductos/obtenerProductos?incluirTarjetas=true"),
      apiGet<typeof clientData>(jar, "bff-ppersonas-clientes/clientes/"),
    ]);
    debugLog.push(`  Found ${products.productos.length} products`);
  } catch (err) {
    return { success: false, bank, movements: [], error: `No se pudo obtener datos: ${err instanceof Error ? err.message : String(err)}`, debug: debugLog.join("\n") };
  }

  // Balance
  let balance: number | undefined;
  try {
    const saldos = await apiGet<Array<{ moneda: string; tipo: string; disponible: number }>>(jar, "bff-pp-prod-ctas-saldos/productos/cuentas/saldos");
    const clp = saldos.find(s => s.moneda === "CLP" && s.tipo === "CUENTA_CORRIENTE");
    if (clp) { balance = clp.disponible; debugLog.push(`  Balance CLP: $${balance}`); }
  } catch { /* ignore */ }

  const fullName = products.nombre || `${clientData.datosCliente.nombres} ${clientData.datosCliente.apellidoPaterno}`.trim();

  // Account movements
  debugLog.push("6. Fetching account movements via API...");
  progress("Extrayendo movimientos de cuenta...");
  const acctResult = await fetchAccountMovements(jar, products.productos, fullName, products.rut, debugLog);
  if (balance === undefined && acctResult.balance !== undefined) balance = acctResult.balance;
  debugLog.push(`  Account movements: ${acctResult.movements.length}`);

  // Credit card data
  debugLog.push("7. Fetching credit card data via API...");
  progress("Extrayendo datos de tarjeta de crédito...");
  const tcResult = await fetchCreditCardData(jar, fullName, debugLog);
  debugLog.push(`  TC movements: ${tcResult.movements.length}`);

  const deduplicated = deduplicateMovements([...acctResult.movements, ...tcResult.movements]);
  debugLog.push(`8. Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  return { success: true, bank, movements: deduplicated, balance, creditCards: tcResult.creditCards.length > 0 ? tcResult.creditCards : undefined, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const bchile: BankScraper = {
  id: "bchile",
  name: "Banco de Chile",
  url: "https://portalpersonas.bancochile.cl",
  mode: "api",
  scrape: (options) => runApiScraper("bchile", options, scrapeBchile),
};

export default bchile;
