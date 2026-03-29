import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Racional API constants ──────────────────────────────────────
//
// Racional is an Ionic/Angular app backed by Firebase (project: racional-prod)
// and DriveWealth (US stock brokerage).
//
// Auth: Firebase REST API → signInWithPassword → idToken
// Data: Top-level Firestore collections (deposits, withdrawals, contributions,
//       goals) filtered by userId, plus Cloud Functions for account summaries.
//
// Movements live in top-level collections (NOT subcollections under users).
// Each document has a `userId` field that matches `localId` from Firebase Auth.

const FIREBASE_API_KEY = "AIzaSyCHCBAaUWhTc8mGtyqfahJ4cYpeVACoCJk";
const FIREBASE_AUTH_URL = "https://identitytoolkit.googleapis.com/v1";
const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/racional-prod/databases/(default)/documents";
const CLOUD_FN_BASE = "https://us-central1-racional-prod.cloudfunctions.net";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// ─── Firebase Auth types ─────────────────────────────────────────

interface FirebaseSignInResponse {
  idToken: string;
  email: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
  registered: boolean;
}

interface FirebaseRefreshResponse {
  id_token: string;
  refresh_token: string;
  expires_in: string;
  token_type: string;
  user_id: string;
  project_id: string;
}

interface FirebaseMfaError {
  error: {
    code: number;
    message: string;
    errors: Array<{ message: string; domain: string; reason: string }>;
  };
}

// ─── Data types ──────────────────────────────────────────────────

interface RacionalGoal {
  id: string;
  name: string;
  portfolioId?: string;
  value: number;   // CLP value
}

// ─── Firebase Auth ───────────────────────────────────────────────

async function firebaseSignIn(
  email: string,
  password: string,
  debugLog: string[],
): Promise<{ success: true; idToken: string; refreshToken: string; localId: string } | { success: false; error: string }> {
  debugLog.push("1. Authenticating via Firebase...");

  const res = await fetch(`${FIREBASE_AUTH_URL}/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: "Unknown error" } })) as FirebaseMfaError;
    const msg = body.error?.message || `HTTP ${res.status}`;

    if (msg === "EMAIL_NOT_FOUND" || msg === "INVALID_EMAIL") {
      return { success: false, error: "Email no registrado en Racional." };
    }
    if (msg === "INVALID_PASSWORD" || msg === "INVALID_LOGIN_CREDENTIALS") {
      return { success: false, error: "Contrasena incorrecta." };
    }
    if (msg === "USER_DISABLED") {
      return { success: false, error: "Cuenta deshabilitada." };
    }
    if (msg === "TOO_MANY_ATTEMPTS_TRY_LATER") {
      return { success: false, error: "Demasiados intentos. Intenta mas tarde." };
    }
    if (msg.startsWith("MISSING_MFA") || msg.includes("MFA")) {
      return { success: false, error: `Se requiere autenticacion multi-factor: ${msg}` };
    }

    return { success: false, error: `Error de Firebase Auth: ${msg}` };
  }

  const data = await res.json() as FirebaseSignInResponse;
  debugLog.push(`  Auth OK - user: ${data.email} (${data.localId})`);
  return { success: true, idToken: data.idToken, refreshToken: data.refreshToken, localId: data.localId };
}

async function firebaseRefreshToken(
  refreshToken: string,
  debugLog: string[],
): Promise<{ idToken: string; refreshToken: string } | null> {
  debugLog.push("0. Refreshing Firebase token...");
  try {
    const res = await fetch(`${FIREBASE_TOKEN_URL}?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    if (!res.ok) return null;
    const data = await res.json() as FirebaseRefreshResponse;
    debugLog.push("  Token refreshed successfully");
    return { idToken: data.id_token, refreshToken: data.refresh_token };
  } catch {
    return null;
  }
}

// ─── Firestore helpers ───────────────────────────────────────────

interface FirestoreDocument {
  name: string;
  fields: Record<string, FirestoreValue>;
  createTime?: string;
  updateTime?: string;
}

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  mapValue?: { fields: Record<string, FirestoreValue> };
  arrayValue?: { values?: FirestoreValue[] };
  nullValue?: null;
  referenceValue?: string;
}

/** Extract the plain JS value from a Firestore typed value. */
function fsVal(v: FirestoreValue | undefined): string | number | boolean | null {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.referenceValue !== undefined) return v.referenceValue;
  return null;
}

/** Recursively extract a Firestore value into a plain JS object/array/primitive. */
function fsDeep(v: FirestoreValue | undefined): unknown {
  if (!v) return null;
  if (v.nullValue !== undefined) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.referenceValue !== undefined) return v.referenceValue;
  if (v.mapValue?.fields) {
    const out: Record<string, unknown> = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields)) {
      out[k] = fsDeep(fv);
    }
    return out;
  }
  if (v.arrayValue?.values) {
    return v.arrayValue.values.map(fsDeep);
  }
  return null;
}

/** Convert a Firestore document to a plain JS object with its document ID. */
function docToObject(doc: FirestoreDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    out[k] = fsDeep(v);
  }
  // Include the document ID extracted from the document name path
  out._docId = doc.name.split("/").pop() || "";
  // Include the full document path for unique identification
  out._docPath = doc.name;
  return out;
}

const authHeaders = (idToken: string) => ({
  Authorization: `Bearer ${idToken}`,
  Accept: "application/json",
  "User-Agent": UA,
});

// ─── Firestore runQuery (top-level collections with userId filter) ───

interface RunQueryResult {
  document?: FirestoreDocument;
  readTime?: string;
}

/**
 * Query a top-level Firestore collection filtered by a single field.
 * Uses the Firestore REST runQuery endpoint.
 * Returns ALL matching documents (no pagination needed for small collections).
 */
async function firestoreQueryByField(
  collectionId: string,
  fieldPath: string,
  userId: string,
  idToken: string,
  orderByField?: string,
): Promise<FirestoreDocument[]> {
  const url = `${FIRESTORE_BASE}:runQuery`;

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId }],
    where: {
      fieldFilter: {
        field: { fieldPath },
        op: "EQUAL",
        value: { stringValue: userId },
      },
    },
  };

  if (orderByField) {
    structuredQuery.orderBy = [
      { field: { fieldPath: orderByField }, direction: "DESCENDING" },
    ];
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(idToken), "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!res.ok) return [];

  const results = await res.json() as RunQueryResult[];
  return results.filter(r => r.document).map(r => r.document!);
}

/**
 * Query a top-level Firestore collection trying multiple field names
 * (userId, uid, userUid) and merging results, deduplicated by document path.
 * Newer Racional documents may use `uid` instead of `userId`.
 */
async function firestoreQueryByUser(
  collectionId: string,
  localId: string,
  idToken: string,
  orderByField?: string,
): Promise<FirestoreDocument[]> {
  const fieldNames = ["userId", "uid", "userUid"];
  const seen = new Set<string>();
  const merged: FirestoreDocument[] = [];

  for (const field of fieldNames) {
    try {
      const docs = await firestoreQueryByField(collectionId, field, localId, idToken, orderByField);
      for (const doc of docs) {
        if (!seen.has(doc.name)) {
          seen.add(doc.name);
          merged.push(doc);
        }
      }
    } catch {
      // ignore individual field query failures
    }
  }

  return merged;
}

// ─── Cloud Functions helpers ─────────────────────────────────────

/** Call a Firebase Cloud Function (HTTPS callable protocol). */
async function callCloudFunction(
  fnName: string,
  data: unknown,
  idToken: string,
): Promise<{ ok: true; result: unknown } | { ok: false; status: number; body?: string }> {
  const url = `${CLOUD_FN_BASE}/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(idToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, body };
  }
  const json = await res.json() as { result?: unknown };
  return { ok: true, result: json.result ?? json };
}

// ─── Date helpers ────────────────────────────────────────────────

/** Convert a Firestore timestamp or ISO string to dd-mm-yyyy. */
function toDate(raw: unknown): string {
  if (!raw) return "";
  const s = String(raw);
  // Handle ISO timestamps: 2026-03-27T12:00:00Z or 2026-03-27T12:00:00.000Z
  const isoDate = s.split("T")[0];
  const ymdMatch = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    return normalizeDate(`${ymdMatch[3]}-${ymdMatch[2]}-${ymdMatch[1]}`);
  }
  return normalizeDate(s);
}

// ─── Amount extraction helper ────────────────────────────────────

/** Try multiple field names for amount extraction, returning the first non-zero value. */
function extractAmount(obj: Record<string, unknown>, ...fields: string[]): number {
  for (const field of fields) {
    const val = Number(obj[field] || 0);
    if (val !== 0) return val;
  }
  return 0;
}

// ─── Collection-specific mappers ─────────────────────────────────

/** Map a deposits collection document to a BankMovement. */
function mapDeposit(obj: Record<string, unknown>, debugLog: string[]): BankMovement | null {
  const date = toDate(obj.createdAt || obj.date || obj.executionDate);
  if (!date) {
    debugLog.push(`    [deposit skip] no date - keys: ${Object.keys(obj).filter(k => !k.startsWith("_")).join(", ")}`);
    return null;
  }

  // Check all plausible amount fields — matches the withdrawal/contribution pattern
  let rawAmount = 0;

  // Try executedShareVariations first (array of share variation objects, same as withdrawals)
  const variations = obj.executedShareVariations;
  if (Array.isArray(variations) && variations.length > 0) {
    for (const v of variations) {
      const varObj = v as Record<string, unknown>;
      rawAmount += Number(varObj.amount || varObj.clpAmount || varObj.value || 0);
    }
  }

  if (rawAmount === 0) {
    rawAmount = extractAmount(obj, "amount", "clpAmount", "totalAmount", "value", "shares", "total", "clpValue");
  }

  if (rawAmount === 0) {
    debugLog.push(`    [deposit skip] zero amount - keys: ${Object.keys(obj).filter(k => !k.startsWith("_")).join(", ")}`);
    return null;
  }

  const docId = String(obj._docId || "");
  const isBuy = obj.isBuy === true;
  const description = isBuy ? "Compra" : "Deposito";

  return {
    date,
    description: docId ? `${description} (${docId})` : description,
    amount: Math.abs(Math.round(rawAmount)),
    balance: 0,
    source: MOVEMENT_SOURCE.account,
  };
}

/** Map a withdrawals collection document to a BankMovement. */
function mapWithdrawal(obj: Record<string, unknown>, debugLog: string[]): BankMovement | null {
  // withdrawals use executionDate as primary date field
  const date = toDate(obj.executionDate || obj.createdAt || obj.date);
  if (!date) {
    debugLog.push(`    [withdrawal skip] no date - keys: ${Object.keys(obj).filter(k => !k.startsWith("_")).join(", ")}`);
    return null;
  }

  // Withdrawals may store amount in executedShareVariations or as a direct amount
  let rawAmount = 0;

  // Try executedShareVariations first — it's an array of share variation objects
  const variations = obj.executedShareVariations;
  if (Array.isArray(variations) && variations.length > 0) {
    for (const v of variations) {
      const varObj = v as Record<string, unknown>;
      rawAmount += Number(varObj.amount || varObj.clpAmount || varObj.value || 0);
    }
  }

  if (rawAmount === 0) {
    rawAmount = extractAmount(obj, "amount", "clpAmount", "value", "totalAmount", "total", "clpValue", "shares");
  }

  if (rawAmount === 0) {
    debugLog.push(`    [withdrawal skip] zero amount - keys: ${Object.keys(obj).filter(k => !k.startsWith("_")).join(", ")}`);
    return null;
  }

  const docId = String(obj._docId || "");
  const isSell = obj.isSell === true;
  const description = isSell ? "Venta" : "Retiro";

  return {
    date,
    description: docId ? `${description} (${docId})` : description,
    amount: -Math.abs(Math.round(rawAmount)),
    balance: 0,
    source: MOVEMENT_SOURCE.account,
  };
}

/** Map a contributions collection document to a BankMovement. */
function mapContribution(obj: Record<string, unknown>, debugLog: string[]): BankMovement | null {
  const date = toDate(obj.createdAt || obj.date || obj.executionDate);
  if (!date) {
    debugLog.push(`    [contribution skip] no date - keys: ${Object.keys(obj).filter(k => !k.startsWith("_")).join(", ")}`);
    return null;
  }

  const rawAmount = extractAmount(obj, "amount", "clpAmount", "value", "totalAmount", "total", "clpValue");
  if (rawAmount === 0) {
    debugLog.push(`    [contribution skip] zero amount - keys: ${Object.keys(obj).filter(k => !k.startsWith("_")).join(", ")}`);
    return null;
  }

  // Determine type: dividends are positive, commissions are negative
  const type = String(obj.type || obj.contributionType || obj.category || "").toLowerCase();

  let description: string;
  let sign: number;

  if (type.includes("comisi") || type.includes("fee") || type.includes("commission")) {
    description = "Comision";
    sign = -1;
  } else if (type.includes("dividend") || type.includes("dividendo")) {
    description = "Dividendo";
    sign = 1;
  } else if (type.includes("inter") || type.includes("interest")) {
    description = "Interes";
    sign = 1;
  } else if (type.includes("tax") || type.includes("impuesto")) {
    description = "Impuesto";
    sign = -1;
  } else {
    // Default: positive (income). Most contributions are dividends.
    description = type || "Contribucion";
    // If amount is already negative in the source, respect that
    sign = rawAmount < 0 ? -1 : 1;
  }

  const docId = String(obj._docId || "");

  return {
    date,
    description: docId ? `${description} (${docId})` : description,
    amount: sign * Math.abs(Math.round(rawAmount)),
    balance: 0,
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── Deep value extraction from nested objects ───────────────────

/**
 * Search for a numeric value in an object by trying multiple field names,
 * including nested paths like result.data.equity.
 */
function deepExtractNumber(obj: Record<string, unknown>, ...fields: string[]): number {
  // Try top-level fields first
  for (const field of fields) {
    const val = Number(obj[field] || 0);
    if (val !== 0) return val;
  }
  // Try one level deep: obj.data.field, obj.result.field, etc.
  const nestedContainers = ["data", "result", "account", "summary", "portfolio", "response"];
  for (const container of nestedContainers) {
    const nested = obj[container];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedObj = nested as Record<string, unknown>;
      for (const field of fields) {
        const val = Number(nestedObj[field] || 0);
        if (val !== 0) return val;
      }
    }
  }
  return 0;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeRacional(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: email, password, onProgress } = options;
  const bank = "racional";
  const progress = onProgress || (() => {});

  progress("Conectando con Racional...");

  // ── Step 1: Firebase Auth ──
  const authResult = await firebaseSignIn(email, password, debugLog);
  if (!authResult.success) {
    return { success: false, bank, movements: [], error: authResult.error, debug: debugLog.join("\n") };
  }
  const { idToken, refreshToken, localId } = authResult;

  progress("Sesion iniciada correctamente");
  debugLog.push("2. Fetching data from Firestore top-level collections...");

  // ── Step 2: Fetch goals (portfolio names + values for balance) ──
  const goals: RacionalGoal[] = [];
  try {
    const goalDocs = await firestoreQueryByUser("goals", localId, idToken);
    debugLog.push(`  goals: ${goalDocs.length} document(s)`);
    for (const doc of goalDocs) {
      const obj = docToObject(doc);
      const name = String(obj.name || obj.title || obj.label || "Meta");
      const id = String(obj._docId || "");
      const portfolioId = obj.portfolioId ? String(obj.portfolioId) : undefined;
      // Try all plausible value fields for goal balance
      const value = Number(
        obj.clpValue || obj.currentValue || obj.value || obj.balance ||
        obj.totalValue || obj.clpBalance || obj.currentBalance ||
        obj.marketValue || obj.totalBalance || obj.equity || 0,
      );
      goals.push({ id, name, portfolioId, value: Math.round(value) });
      debugLog.push(`    Goal: "${name}" (id=${id}, portfolioId=${portfolioId || "none"}, value=${Math.round(value)})`);
      if (value === 0) {
        debugLog.push(`      [goal warning] zero value - keys: ${Object.keys(obj).filter(k => !k.startsWith("_")).join(", ")}`);
      }
    }
  } catch (e) {
    debugLog.push(`  goals query failed: ${e}`);
  }

  progress("Obteniendo movimientos...");

  // ── Step 3: Fetch deposits (all history — no date limits) ──
  const allMovements: BankMovement[] = [];

  try {
    const depositDocs = await firestoreQueryByUser("deposits", localId, idToken);
    debugLog.push(`  deposits: ${depositDocs.length} document(s)`);
    let depositCount = 0;
    for (const doc of depositDocs) {
      const mv = mapDeposit(docToObject(doc), debugLog);
      if (mv) {
        allMovements.push(mv);
        depositCount++;
      }
    }
    debugLog.push(`    Mapped ${depositCount} deposit movement(s)`);
  } catch (e) {
    debugLog.push(`  deposits query failed: ${e}`);
  }

  // ── Step 4: Fetch withdrawals (all history — no date limits) ──
  try {
    const withdrawalDocs = await firestoreQueryByUser("withdrawals", localId, idToken);
    debugLog.push(`  withdrawals: ${withdrawalDocs.length} document(s)`);
    let withdrawalCount = 0;
    for (const doc of withdrawalDocs) {
      const mv = mapWithdrawal(docToObject(doc), debugLog);
      if (mv) {
        allMovements.push(mv);
        withdrawalCount++;
      }
    }
    debugLog.push(`    Mapped ${withdrawalCount} withdrawal movement(s)`);
  } catch (e) {
    debugLog.push(`  withdrawals query failed: ${e}`);
  }

  // ── Step 5: Fetch contributions (dividends, commissions, etc. — all history) ──
  try {
    const contribDocs = await firestoreQueryByUser("contributions", localId, idToken);
    debugLog.push(`  contributions: ${contribDocs.length} document(s)`);
    let contribCount = 0;
    for (const doc of contribDocs) {
      const mv = mapContribution(docToObject(doc), debugLog);
      if (mv) {
        allMovements.push(mv);
        contribCount++;
      }
    }
    debugLog.push(`    Mapped ${contribCount} contribution movement(s)`);
  } catch (e) {
    debugLog.push(`  contributions query failed: ${e}`);
  }

  // ── Step 6: Fetch transactions collection (newer movement format) ──
  try {
    const txDocs = await firestoreQueryByUser("transactions", localId, idToken);
    debugLog.push(`  transactions: ${txDocs.length} document(s)`);
    let txCount = 0;
    for (const doc of txDocs) {
      const obj = docToObject(doc);
      // Classify by type field, then map to deposit/withdrawal/contribution
      const type = String(obj.type || obj.transactionType || obj.kind || "").toLowerCase();
      let mv: BankMovement | null = null;
      if (type.includes("deposit") || type.includes("deposito") || type.includes("buy") || type.includes("compra") || type === "in") {
        mv = mapDeposit(obj, debugLog);
      } else if (type.includes("withdraw") || type.includes("retiro") || type.includes("sell") || type.includes("venta") || type === "out") {
        mv = mapWithdrawal(obj, debugLog);
      } else if (type.includes("dividend") || type.includes("dividendo") || type.includes("comisi") || type.includes("fee") || type.includes("interest")) {
        mv = mapContribution(obj, debugLog);
      } else {
        // Unknown type — try as deposit (positive amount) or withdrawal (negative)
        const rawAmount = extractAmount(obj, "amount", "clpAmount", "value", "totalAmount", "total");
        if (rawAmount < 0) {
          mv = mapWithdrawal(obj, debugLog);
        } else {
          mv = mapDeposit(obj, debugLog);
        }
      }
      if (mv) {
        allMovements.push(mv);
        txCount++;
      }
    }
    debugLog.push(`    Mapped ${txCount} transaction movement(s)`);
  } catch (e) {
    debugLog.push(`  transactions query failed: ${e}`);
  }

  // ── Step 6b: Fetch orders collection (buy/sell orders) ──
  try {
    const orderDocs = await firestoreQueryByUser("orders", localId, idToken);
    debugLog.push(`  orders: ${orderDocs.length} document(s)`);
    let orderCount = 0;
    for (const doc of orderDocs) {
      const obj = docToObject(doc);
      const side = String(obj.side || obj.orderType || obj.type || "").toLowerCase();
      let mv: BankMovement | null = null;
      if (side.includes("sell") || side.includes("venta")) {
        mv = mapWithdrawal(obj, debugLog);
      } else {
        mv = mapDeposit(obj, debugLog);
      }
      if (mv) {
        allMovements.push(mv);
        orderCount++;
      }
    }
    debugLog.push(`    Mapped ${orderCount} order movement(s)`);
  } catch (e) {
    debugLog.push(`  orders query failed: ${e}`);
  }

  // ── Step 7: Try DrivewealthAccountSummary for balance data ──
  let balance = 0;

  try {
    debugLog.push("3. Calling DrivewealthAccountSummary...");

    // Try multiple payload shapes — older API uses { userId }, newer may use { uid }
    const payloads = [
      { userId: localId },
      { uid: localId },
      { userUid: localId },
      {},
    ];

    let summaryResult: Record<string, unknown> | null = null;
    for (const payload of payloads) {
      const summaryRes = await callCloudFunction("DrivewealthAccountSummary", payload, idToken);
      if (summaryRes.ok && summaryRes.result) {
        summaryResult = summaryRes.result as Record<string, unknown>;
        debugLog.push(`  Cloud function OK with payload: ${JSON.stringify(payload)}`);
        break;
      } else if (!summaryRes.ok) {
        debugLog.push(`  DrivewealthAccountSummary(${JSON.stringify(payload)}) failed: HTTP ${summaryRes.status}`);
      }
    }

    if (summaryResult) {
      debugLog.push(`  Cloud function response keys: ${Object.keys(summaryResult).join(", ")}`);

      // Extract balance using deep path checking (result.data.equity, etc.)
      const equity = deepExtractNumber(
        summaryResult,
        "equity", "totalEquity", "accountBalance",
        "cashBalance", "cash", "balance", "total",
        "clpEquity", "clpBalance", "clpTotal",
        "totalValue", "marketValue", "netValue",
      );

      if (equity > 0) {
        balance = Math.round(equity);
        debugLog.push(`  Account summary balance: $${balance.toLocaleString("es-CL")}`);
      } else {
        debugLog.push(`  Account summary returned but no balance extracted.`);
        debugLog.push(`    Top-level keys: ${Object.keys(summaryResult).join(", ")}`);
        for (const [k, v] of Object.entries(summaryResult)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            debugLog.push(`    ${k} keys: ${Object.keys(v as Record<string, unknown>).join(", ")}`);
          }
        }
      }
    }
  } catch (e) {
    debugLog.push(`  DrivewealthAccountSummary error: ${e}`);
  }

  // Fall back: compute balance from goal values (sum clpValue, currentValue, value, etc.)
  if (!balance && goals.length > 0) {
    balance = goals.reduce((sum, g) => sum + g.value, 0);
    if (balance > 0) {
      debugLog.push(`  Computed balance from ${goals.length} goal(s): $${Math.round(balance).toLocaleString("es-CL")}`);
    }
  }

  // ── Step 7: Fallback — if no movements, create snapshots from goals ──
  if (allMovements.length === 0 && goals.length > 0) {
    debugLog.push("  No movement history found - creating portfolio balance snapshots from goals");
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const dateStr = `${dd}-${mm}-${yyyy}`;

    for (const g of goals) {
      if (g.value > 0) {
        allMovements.push({
          date: dateStr,
          description: `${g.name} (${g.id})`,
          amount: g.value,
          balance: g.value,
          source: MOVEMENT_SOURCE.account as typeof MOVEMENT_SOURCE.account,
        });
      }
    }
  }

  // Dedup uses date|description|amount|balance|source|owner as the key.
  // Because we embed the Firestore document ID in the description (e.g. "Deposito (abc123)"),
  // each document produces a unique dedup key even when date/amount/balance are identical.
  const deduplicated = deduplicateMovements(allMovements);
  debugLog.push(`4. Total: ${deduplicated.length} unique movement(s) (before dedup: ${allMovements.length})`);
  progress(`Listo - ${deduplicated.length} movimientos totales`);

  // Persist tokens for next run
  const sessionCookies = JSON.stringify({ idToken, refreshToken, localId });

  return {
    success: true,
    bank,
    movements: deduplicated,
    balance: balance || undefined,
    sessionCookies,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const racional: BankScraper = {
  id: "racional",
  name: "Racional",
  url: "https://app.racional.cl",
  mode: "api",
  scrape: (options) => runApiScraper("racional", options, scrapeRacional),
};

export default racional;
