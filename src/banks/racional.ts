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
// Data: Cloud Functions at us-central1-racional-prod.cloudfunctions.net
//       + Firestore for user profile and goal configuration
//
// The web app at app.racional.cl fetches portfolio and movement data
// via Firebase Cloud Functions, NOT direct Firestore reads. The user
// document in Firestore contains goal definitions and portfolio config,
// while movements come from DriveWealth via Cloud Functions.

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
  value: number;   // CLP value
  currency?: string;
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
      return { success: false, error: "Contraseña incorrecta." };
    }
    if (msg === "USER_DISABLED") {
      return { success: false, error: "Cuenta deshabilitada." };
    }
    if (msg === "TOO_MANY_ATTEMPTS_TRY_LATER") {
      return { success: false, error: "Demasiados intentos. Intenta más tarde." };
    }
    if (msg.startsWith("MISSING_MFA") || msg.includes("MFA")) {
      return { success: false, error: `Se requiere autenticacion multi-factor: ${msg}` };
    }

    return { success: false, error: `Error de Firebase Auth: ${msg}` };
  }

  const data = await res.json() as FirebaseSignInResponse;
  debugLog.push(`  Auth OK — user: ${data.email} (${data.localId})`);
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

interface FirestoreListResponse {
  documents?: FirestoreDocument[];
  nextPageToken?: string;
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

/** Convert a Firestore document to a plain JS object. */
function docToObject(doc: FirestoreDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    out[k] = fsDeep(v);
  }
  return out;
}

const authHeaders = (idToken: string) => ({
  Authorization: `Bearer ${idToken}`,
  Accept: "application/json",
  "User-Agent": UA,
});

async function firestoreGetDoc(path: string, idToken: string): Promise<{ ok: true; data: FirestoreDocument } | { ok: false; status: number; body?: string }> {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, { headers: authHeaders(idToken) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, body };
  }
  return { ok: true, data: await res.json() as FirestoreDocument };
}

async function firestoreList(path: string, idToken: string, pageSize = 100): Promise<{ ok: true; data: FirestoreListResponse } | { ok: false; status: number }> {
  const url = `${FIRESTORE_BASE}/${path}?pageSize=${pageSize}`;
  const res = await fetch(url, { headers: authHeaders(idToken) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() as FirestoreListResponse };
}

/** List all subcollection IDs under a document using the Firestore REST API. */
async function firestoreListCollections(docPath: string, idToken: string): Promise<string[]> {
  const url = `${FIRESTORE_BASE}/${docPath}:listCollectionIds`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(idToken), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) return [];
  const data = await res.json() as { collectionIds?: string[] };
  return data.collectionIds || [];
}

/** Run a Firestore structured query on a parent path (collectionId-based). */
async function firestoreRunQuery(
  parentPath: string,
  collectionId: string,
  idToken: string,
  orderBy?: string,
  limit?: number,
): Promise<FirestoreDocument[]> {
  // parentPath: e.g. "users/abc123" — the query runs on parentPath/collectionId
  const url = `${FIRESTORE_BASE}/${parentPath}:runQuery`;
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId }],
  };
  if (orderBy) {
    structuredQuery.orderBy = [{ field: { fieldPath: orderBy }, direction: "DESCENDING" }];
  }
  if (limit) {
    structuredQuery.limit = limit;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(idToken), "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) return [];
  const results = await res.json() as Array<{ document?: FirestoreDocument; readTime?: string }>;
  return results.filter(r => r.document).map(r => r.document!);
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

// ─── Data discovery and fetching ─────────────────────────────────

/** Movement type → sign mapping. Deposits and dividends are positive; withdrawals, fees are negative. */
function movementSign(type: string): number {
  const t = type.toLowerCase().trim();
  // Negative types
  if (t.includes("retiro") || t.includes("withdrawal") || t.includes("rescate")) return -1;
  if (t.includes("comisi") || t.includes("fee") || t.includes("commission")) return -1;
  if (t.includes("compra") || t.includes("purchase") || t.includes("buy")) return -1;
  // Positive types
  if (t.includes("dep") || t.includes("deposit") || t.includes("aporte")) return 1;
  if (t.includes("dividend") || t.includes("dividendo")) return 1;
  if (t.includes("interest") || t.includes("inter")) return 1;
  if (t.includes("venta") || t.includes("sell") || t.includes("sale")) return 1;
  // Default: positive (income)
  return 1;
}

/** Human-readable movement type for description. */
function movementLabel(type: string): string {
  const t = type.toLowerCase().trim();
  if (t.includes("retiro") || t.includes("withdrawal") || t.includes("rescate")) return "Retiro";
  if (t.includes("comisi") || t.includes("fee") || t.includes("commission")) return "Comision";
  if (t.includes("dep") || t.includes("deposit") || t.includes("aporte")) return "Deposito";
  if (t.includes("dividend") || t.includes("dividendo")) return "Dividendo";
  if (t.includes("compra") || t.includes("purchase") || t.includes("buy")) return "Compra";
  if (t.includes("venta") || t.includes("sell") || t.includes("sale")) return "Venta";
  if (t.includes("interest") || t.includes("inter")) return "Interes";
  return type || "Movimiento";
}

/** Extract a date from various possible field names and formats. */
function extractDate(obj: Record<string, unknown>): string {
  const raw = String(
    obj.date || obj.createdAt || obj.created_at || obj.timestamp ||
    obj.fecha || obj.executedAt || obj.executed_at || obj.settledAt ||
    obj.processedAt || obj.transactionDate || obj.created || "",
  );
  if (!raw) return "";
  // Handle ISO timestamps: 2026-03-27T12:00:00Z → 2026-03-27
  const isoDate = raw.split("T")[0];
  // Convert YYYY-MM-DD to DD-MM-YYYY for normalizeDate
  const ymdMatch = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    return normalizeDate(`${ymdMatch[3]}-${ymdMatch[2]}-${ymdMatch[1]}`);
  }
  return normalizeDate(isoDate);
}

/** Extract amount from various possible field names. */
function extractAmount(obj: Record<string, unknown>): number {
  return Number(
    obj.amount || obj.monto || obj.value || obj.clpAmount ||
    obj.clpValue || obj.totalAmount || obj.total || 0,
  );
}

/** Extract movement type from various possible field names. */
function extractType(obj: Record<string, unknown>): string {
  return String(
    obj.type || obj.tipo || obj.movementType || obj.transactionType ||
    obj.category || obj.operationType || "",
  );
}

/** Extract description from various possible field names. */
function extractDescription(obj: Record<string, unknown>): string {
  return String(
    obj.description || obj.desc || obj.descripcion || obj.detail ||
    obj.detalle || obj.concept || obj.concepto || obj.name || obj.label || "",
  );
}

/** Convert a raw object (from Firestore doc or Cloud Function) to a BankMovement. */
function toMovement(obj: Record<string, unknown>, goalName?: string): BankMovement | null {
  const date = extractDate(obj);
  if (!date) return null;

  const rawAmount = extractAmount(obj);
  if (rawAmount === 0) return null;

  const type = extractType(obj);
  const sign = movementSign(type);
  const amount = sign * Math.abs(Math.round(rawAmount));

  const desc = extractDescription(obj);
  const label = movementLabel(type);
  const description = desc
    ? (goalName ? `${label} - ${desc} (${goalName})` : `${label} - ${desc}`)
    : (goalName ? `${label} (${goalName})` : label);

  return {
    date,
    description,
    amount,
    balance: 0,
    source: MOVEMENT_SOURCE.account,
  };
}

// ─── Strategy 1: Cloud Functions ─────────────────────────────────

/** Try to fetch movements via Firebase Cloud Functions. */
async function tryCloudFunctions(
  userId: string,
  idToken: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; goals: RacionalGoal[] } | null> {
  debugLog.push("3a. Trying Cloud Functions...");

  // Common Cloud Function names for Racional (Ionic/Angular + DriveWealth pattern)
  const movementFnCandidates = [
    "getMovements", "getTransactions", "getUserMovements", "getUserTransactions",
    "movements", "transactions", "getActivity", "getHistory",
    "api-getMovements", "api-getTransactions", "api/getMovements",
    "getAccountActivity", "getPortfolioMovements",
  ];
  const portfolioFnCandidates = [
    "getPortfolio", "getUserPortfolio", "getGoals", "getUserGoals",
    "portfolio", "goals", "getAccounts", "getPositions",
    "api-getPortfolio", "api-getGoals", "api/getPortfolio",
    "getAccountSummary", "getDashboard", "getSummary",
  ];

  const movements: BankMovement[] = [];
  const goals: RacionalGoal[] = [];

  // Try portfolio Cloud Functions
  for (const fn of portfolioFnCandidates) {
    const res = await callCloudFunction(fn, { userId }, idToken);
    if (res.ok && res.result) {
      debugLog.push(`  Cloud Function ${fn} responded OK`);
      const result = res.result as Record<string, unknown>;
      // Try to extract goals/portfolio from the response
      const items = (Array.isArray(result) ? result : result.goals || result.portfolio || result.accounts || result.data || result.items || []) as Record<string, unknown>[];
      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          const name = String(item.name || item.title || item.label || "Meta");
          const value = Number(item.value || item.balance || item.nav || item.clpValue || item.totalValue || item.amount || 0);
          const id = String(item.id || item.goalId || "");
          goals.push({ id, name, value: Math.round(value) });
        }
        debugLog.push(`  Found ${goals.length} goal(s) via Cloud Function ${fn}`);
        break;
      }
    }
  }

  // Try movement Cloud Functions
  for (const fn of movementFnCandidates) {
    const res = await callCloudFunction(fn, { userId }, idToken);
    if (res.ok && res.result) {
      debugLog.push(`  Cloud Function ${fn} responded OK`);
      const result = res.result as Record<string, unknown>;
      const items = (Array.isArray(result) ? result : result.movements || result.transactions || result.activity || result.data || result.items || result.history || []) as Record<string, unknown>[];
      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          const mv = toMovement(item);
          if (mv) movements.push(mv);
        }
        debugLog.push(`  Found ${movements.length} movement(s) via Cloud Function ${fn}`);
        break;
      }
    }
  }

  if (movements.length > 0 || goals.length > 0) {
    return { movements, goals };
  }
  debugLog.push("  No data from Cloud Functions");
  return null;
}

// ─── Strategy 2: Firestore subcollection discovery ───────────────

/** Discover the actual Firestore subcollection structure via listCollectionIds. */
async function discoverFirestoreStructure(
  userId: string,
  idToken: string,
  debugLog: string[],
): Promise<{ movements: BankMovement[]; goals: RacionalGoal[]; balance: number }> {
  debugLog.push("3b. Discovering Firestore structure...");

  const userBase = `users/${userId}`;
  const movements: BankMovement[] = [];
  const goals: RacionalGoal[] = [];
  let balance = 0;

  // Step 1: Read the user document
  const userDocRes = await firestoreGetDoc(userBase, idToken);
  let userObj: Record<string, unknown> = {};
  if (userDocRes.ok) {
    userObj = docToObject(userDocRes.data);
    const fields = Object.keys(userDocRes.data.fields || {});
    debugLog.push(`  User doc fields (${fields.length}): ${fields.slice(0, 20).join(", ")}${fields.length > 20 ? "..." : ""}`);

    // Check for embedded portfolio/balance data in the user document
    balance = Number(
      userObj.balance || userObj.totalBalance || userObj.clpBalance ||
      userObj.portfolioValue || userObj.totalValue || userObj.total || 0,
    );
    if (balance > 0) {
      debugLog.push(`  Direct balance in user doc: $${Math.round(balance).toLocaleString("es-CL")}`);
    }

    // Look for embedded goals array in user doc
    const goalsArray = (userObj.goals || userObj.portfolio || userObj.accounts || userObj.metas) as Record<string, unknown>[] | undefined;
    if (Array.isArray(goalsArray)) {
      for (const g of goalsArray) {
        const name = String(g.name || g.title || g.label || "Meta");
        const value = Number(g.value || g.balance || g.nav || g.clpValue || g.totalValue || g.amount || 0);
        const id = String(g.id || g.goalId || "");
        if (name) goals.push({ id, name, value: Math.round(value) });
      }
      if (goals.length > 0) {
        debugLog.push(`  Found ${goals.length} embedded goal(s) in user doc`);
      }
    }

    // Look for embedded movements in user doc
    const movArray = (userObj.movements || userObj.transactions || userObj.activity || userObj.history) as Record<string, unknown>[] | undefined;
    if (Array.isArray(movArray)) {
      for (const item of movArray) {
        const mv = toMovement(item);
        if (mv) movements.push(mv);
      }
      if (movements.length > 0) {
        debugLog.push(`  Found ${movements.length} embedded movement(s) in user doc`);
      }
    }
  } else {
    debugLog.push(`  User doc read failed: ${userDocRes.status}`);
  }

  // Step 2: Discover subcollections via listCollectionIds
  const subcollections = await firestoreListCollections(userBase, idToken);
  debugLog.push(`  Subcollections under user doc: ${subcollections.length > 0 ? subcollections.join(", ") : "(none)"}`);

  // Step 3: Try each subcollection
  for (const col of subcollections) {
    const colLower = col.toLowerCase();
    const listRes = await firestoreList(`${userBase}/${col}`, idToken, 200);
    if (!listRes.ok || !listRes.data.documents) continue;

    const docs = listRes.data.documents;
    debugLog.push(`  Collection "${col}": ${docs.length} doc(s)`);

    // Detect if this collection contains goals/portfolio or movements
    if (colLower.includes("goal") || colLower.includes("meta") || colLower.includes("portfolio") || colLower.includes("account") || colLower.includes("investment") || colLower.includes("objective")) {
      // Parse as goals
      for (const doc of docs) {
        const obj = docToObject(doc);
        const name = String(obj.name || obj.title || obj.label || obj.goalName || doc.name.split("/").pop() || "Meta");
        const value = Number(obj.value || obj.balance || obj.nav || obj.clpValue || obj.totalValue || obj.amount || obj.total || 0);
        const id = doc.name.split("/").pop() || "";
        goals.push({ id, name, value: Math.round(value) });

        // Look for nested movements under each goal
        const goalSubcollections = await firestoreListCollections(`${userBase}/${col}/${id}`, idToken);
        if (goalSubcollections.length > 0) {
          debugLog.push(`    Goal "${name}" subcollections: ${goalSubcollections.join(", ")}`);
        }
        for (const subCol of goalSubcollections) {
          const subLower = subCol.toLowerCase();
          if (subLower.includes("mov") || subLower.includes("trans") || subLower.includes("activ") || subLower.includes("hist") || subLower.includes("oper")) {
            const subListRes = await firestoreList(`${userBase}/${col}/${id}/${subCol}`, idToken, 200);
            if (subListRes.ok && subListRes.data.documents) {
              for (const mvDoc of subListRes.data.documents) {
                const mv = toMovement(docToObject(mvDoc), name);
                if (mv) movements.push(mv);
              }
              debugLog.push(`    Found ${subListRes.data.documents.length} doc(s) in ${col}/${id}/${subCol}`);
            }
          }
        }
      }
    } else if (colLower.includes("mov") || colLower.includes("trans") || colLower.includes("activ") || colLower.includes("hist") || colLower.includes("oper") || colLower.includes("transfer") || colLower.includes("deposit") || colLower.includes("withdraw")) {
      // Parse as movements
      for (const doc of docs) {
        const mv = toMovement(docToObject(doc));
        if (mv) movements.push(mv);
      }
      debugLog.push(`  Parsed ${movements.length} movement(s) from "${col}"`);
    } else {
      // Unknown collection — log first doc fields for debugging
      if (docs.length > 0) {
        const sampleFields = Object.keys(docs[0].fields || {});
        debugLog.push(`    Sample fields: ${sampleFields.join(", ")}`);
      }
    }
  }

  // Step 4: If no subcollections found, try well-known paths directly
  if (subcollections.length === 0) {
    debugLog.push("  No subcollections found via listCollectionIds — trying known paths...");

    const knownGoalPaths = ["goals", "metas", "objectives", "portfolios", "accounts", "investments"];
    const knownMovPaths = ["movements", "transactions", "activity", "operations", "history", "transfers"];

    for (const col of knownGoalPaths) {
      const listRes = await firestoreList(`${userBase}/${col}`, idToken);
      if (listRes.ok && listRes.data.documents && listRes.data.documents.length > 0) {
        debugLog.push(`  Found goals at ${userBase}/${col} (${listRes.data.documents.length} doc(s))`);
        for (const doc of listRes.data.documents) {
          const obj = docToObject(doc);
          const name = String(obj.name || obj.title || obj.label || doc.name.split("/").pop() || "Meta");
          const value = Number(obj.value || obj.balance || obj.nav || obj.clpValue || obj.totalValue || obj.amount || 0);
          const id = doc.name.split("/").pop() || "";
          goals.push({ id, name, value: Math.round(value) });

          // Probe for nested movements under each goal
          for (const movCol of knownMovPaths) {
            const nestedRes = await firestoreList(`${userBase}/${col}/${id}/${movCol}`, idToken);
            if (nestedRes.ok && nestedRes.data.documents && nestedRes.data.documents.length > 0) {
              debugLog.push(`  Found movements at goals/${id}/${movCol} (${nestedRes.data.documents.length} doc(s))`);
              for (const mvDoc of nestedRes.data.documents) {
                const mv = toMovement(docToObject(mvDoc), name);
                if (mv) movements.push(mv);
              }
            }
          }
        }
        break;
      }
    }

    // Also try top-level movement collections
    if (movements.length === 0) {
      for (const col of knownMovPaths) {
        const listRes = await firestoreList(`${userBase}/${col}`, idToken);
        if (listRes.ok && listRes.data.documents && listRes.data.documents.length > 0) {
          debugLog.push(`  Found movements at ${userBase}/${col} (${listRes.data.documents.length} doc(s))`);
          for (const doc of listRes.data.documents) {
            const mv = toMovement(docToObject(doc));
            if (mv) movements.push(mv);
          }
          break;
        }
      }
    }
  }

  // Step 5: Try Firestore runQuery to find movements in collection groups
  if (movements.length === 0) {
    debugLog.push("  Trying Firestore runQuery (collection group)...");
    const queryCollections = ["movements", "transactions", "activity", "operations"];
    for (const col of queryCollections) {
      const queryDocs = await firestoreRunQuery(userBase, col, idToken, "date", 100);
      if (queryDocs.length > 0) {
        debugLog.push(`  runQuery found ${queryDocs.length} doc(s) in "${col}"`);
        for (const doc of queryDocs) {
          const mv = toMovement(docToObject(doc));
          if (mv) movements.push(mv);
        }
        break;
      }
    }
  }

  // Compute balance from goals if not found directly
  if (!balance && goals.length > 0) {
    balance = goals.reduce((sum, g) => sum + g.value, 0);
  }

  return { movements, goals, balance };
}

// ─── Strategy 3: Explore user doc for goal references ────────────

/** Extract goal data from the user document and follow references. */
async function extractGoalsFromUserDoc(
  userObj: Record<string, unknown>,
  userId: string,
  idToken: string,
  debugLog: string[],
): Promise<{ goals: RacionalGoal[]; movements: BankMovement[] }> {
  const goals: RacionalGoal[] = [];
  const movements: BankMovement[] = [];

  // Look for map fields that might be goals (e.g., userDoc has goal configs as map values)
  for (const [key, val] of Object.entries(userObj)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      // Check if this looks like a goal config
      if (obj.name || obj.title || obj.label || obj.goalName) {
        const name = String(obj.name || obj.title || obj.label || obj.goalName || key);
        const value = Number(obj.value || obj.balance || obj.nav || obj.clpValue || obj.totalValue || obj.amount || 0);
        const goalId = String(obj.id || obj.goalId || obj.driveWealthAccountId || key);

        if (name && name !== "null" && name !== "undefined") {
          goals.push({ id: goalId, name, value: Math.round(value) });
          debugLog.push(`  Goal from user doc field "${key}": ${name} = $${Math.round(value).toLocaleString("es-CL")}`);

          // Try to read movements under this goal reference
          if (goalId) {
            for (const movCol of ["movements", "transactions", "activity"]) {
              const nestedRes = await firestoreList(`users/${userId}/goals/${goalId}/${movCol}`, idToken);
              if (nestedRes.ok && nestedRes.data.documents && nestedRes.data.documents.length > 0) {
                for (const mvDoc of nestedRes.data.documents) {
                  const mv = toMovement(docToObject(mvDoc), name);
                  if (mv) movements.push(mv);
                }
                debugLog.push(`  Found ${nestedRes.data.documents.length} movement(s) under goals/${goalId}/${movCol}`);
              }
            }
          }
        }
      }
    }
  }

  return { goals, movements };
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeRacional(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: email, password, onProgress } = options;
  const bank = "racional";
  const progress = onProgress || (() => {});

  progress("Conectando con Racional...");

  // Firebase Auth: email + password → idToken
  const authResult = await firebaseSignIn(email, password, debugLog);
  if (!authResult.success) {
    return { success: false, bank, movements: [], error: authResult.error, debug: debugLog.join("\n") };
  }
  const { idToken, refreshToken, localId } = authResult;

  progress("Sesion iniciada correctamente");
  debugLog.push("2. Fetching data...");

  // Strategy 1: Try Cloud Functions (likely endpoint for movements)
  let allMovements: BankMovement[] = [];
  let goals: RacionalGoal[] = [];
  let balance = 0;

  const cfResult = await tryCloudFunctions(localId, idToken, debugLog);
  if (cfResult) {
    allMovements = cfResult.movements;
    goals = cfResult.goals;
    balance = goals.reduce((sum, g) => sum + g.value, 0);
  }

  // Strategy 2: Discover Firestore structure (subcollections, nested paths)
  if (allMovements.length === 0) {
    progress("Buscando datos en Firestore...");
    const fsResult = await discoverFirestoreStructure(localId, idToken, debugLog);
    if (fsResult.movements.length > 0 || fsResult.goals.length > 0) {
      allMovements = fsResult.movements;
      if (fsResult.goals.length > 0) goals = fsResult.goals;
      if (fsResult.balance > 0) balance = fsResult.balance;
    }
  }

  // Strategy 3: Deep-inspect user doc fields for goal references
  if (allMovements.length === 0 && goals.length === 0) {
    debugLog.push("3c. Deep-inspecting user doc for goal references...");
    const userDocRes = await firestoreGetDoc(`users/${localId}`, idToken);
    if (userDocRes.ok) {
      const userObj = docToObject(userDocRes.data);
      const deepResult = await extractGoalsFromUserDoc(userObj, localId, idToken, debugLog);
      if (deepResult.goals.length > 0) goals = deepResult.goals;
      if (deepResult.movements.length > 0) allMovements = deepResult.movements;
    }
  }

  // Compute balance from goals if not set
  if (!balance && goals.length > 0) {
    balance = goals.reduce((sum, g) => sum + g.value, 0);
    debugLog.push(`  Computed balance from ${goals.length} goal(s): $${Math.round(balance).toLocaleString("es-CL")}`);
  }

  // Fallback: if we found goals but no movements, create portfolio snapshots
  if (allMovements.length === 0 && goals.length > 0) {
    debugLog.push("  No movement history found — creating portfolio balance snapshots from goals");
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const dateStr = `${dd}-${mm}-${yyyy}`;

    allMovements = goals
      .filter(g => g.value > 0)
      .map(g => ({
        date: dateStr,
        description: `${g.name} (${g.id})`,
        amount: g.value,
        balance: g.value,
        source: MOVEMENT_SOURCE.account as typeof MOVEMENT_SOURCE.account,
      }));
  }

  const deduplicated = deduplicateMovements(allMovements);
  debugLog.push(`6. Total: ${deduplicated.length} unique movement(s)`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

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
