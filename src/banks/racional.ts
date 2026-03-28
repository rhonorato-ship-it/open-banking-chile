import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { normalizeDate, deduplicateMovements } from "../utils.js";
import { runApiScraper } from "../infrastructure/api-runner.js";

// ─── Racional API constants ──────────────────────────────────────
//
// Racional uses Firebase Authentication (project: racional-prod).
// Auth: Firebase REST API → signInWithPassword → idToken
// Data: Firestore or Cloud Functions (endpoints TBD from DevTools discovery)
//
// Firebase Auth REST API docs:
// https://firebase.google.com/docs/reference/rest/auth

const FIREBASE_API_KEY = "AIzaSyCHCBAaUWhTc8mGtyqfahJ4cYpeVACoCJk";
const FIREBASE_AUTH_URL = "https://identitytoolkit.googleapis.com/v1";
const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

// Data lives in Firestore (project: racional-prod)
const FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/racional-prod/databases/(default)/documents";

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

// ─── Data types (shapes TBD — update after DevTools discovery) ───

interface RacionalPortfolioItem {
  id: string;
  name: string;
  value: number;
  currency?: string;
}

interface RacionalMovementRaw {
  id?: string;
  date: string;
  type: string;
  description: string;
  amount: number;
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
    // MFA required — Firebase returns a specific error for multi-factor auth
    if (msg.startsWith("MISSING_MFA") || msg.includes("MFA")) {
      return { success: false, error: `Se requiere autenticación multi-factor: ${msg}` };
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
  createTime: string;
  updateTime: string;
}

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  mapValue?: { fields: Record<string, FirestoreValue> };
  arrayValue?: { values: FirestoreValue[] };
  nullValue?: null;
}

interface FirestoreListResponse {
  documents?: FirestoreDocument[];
  nextPageToken?: string;
}

function fsVal(v: FirestoreValue | undefined): string | number | boolean | null {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  return null;
}

async function firestoreGet(path: string, idToken: string): Promise<{ ok: true; data: FirestoreListResponse } | { ok: false; status: number }> {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: {
      Authorization: `Bearer ${idToken}`,
      Accept: "application/json",
      "User-Agent": UA,
    },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() as FirestoreListResponse };
}

async function firestoreGetDoc(path: string, idToken: string): Promise<{ ok: true; data: FirestoreDocument } | { ok: false; status: number }> {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: {
      Authorization: `Bearer ${idToken}`,
      Accept: "application/json",
      "User-Agent": UA,
    },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() as FirestoreDocument };
}

// ─── Data fetchers ───────────────────────────────────────────────

interface DiscoveryResult {
  portfolioPath: string | null;
  movementsPath: string | null;
  userDoc: FirestoreDocument | null;
}

async function discoverData(userId: string, idToken: string, debugLog: string[]): Promise<DiscoveryResult> {
  debugLog.push("3. Discovering Firestore data...");

  const userBase = `users/${userId}`;

  // Step 1: Read the user document — portfolio may be embedded as fields
  let userDoc: FirestoreDocument | null = null;
  const userDocRes = await firestoreGetDoc(userBase, idToken);
  if (userDocRes.ok) {
    userDoc = userDocRes.data;
    const fields = Object.keys(userDoc.fields || {});
    debugLog.push(`  User doc fields: ${fields.join(", ")}`);
  } else {
    debugLog.push(`  User doc read failed: ${userDocRes.status}`);
  }

  // Step 2: Try subcollections for portfolio and movements
  const portfolioCandidates = ["portfolio", "portfolios", "holdings", "accounts", "investments", "goals"];
  const movementCandidates = ["movements", "transactions", "activity", "operations", "history", "transfers", "deposits", "withdrawals"];

  let portfolioPath: string | null = null;
  let movementsPath: string | null = null;

  for (const col of portfolioCandidates) {
    const res = await firestoreGet(`${userBase}/${col}`, idToken);
    if (res.ok && res.data.documents && res.data.documents.length > 0) {
      portfolioPath = `${userBase}/${col}`;
      debugLog.push(`  Portfolio subcollection: ${col} (${res.data.documents.length} doc(s))`);
      break;
    }
  }

  for (const col of movementCandidates) {
    const res = await firestoreGet(`${userBase}/${col}`, idToken);
    if (res.ok && res.data.documents && res.data.documents.length > 0) {
      movementsPath = `${userBase}/${col}`;
      debugLog.push(`  Movements subcollection: ${col} (${res.data.documents.length} doc(s))`);
      break;
    }
  }

  return { portfolioPath, movementsPath, userDoc };
}

async function fetchPortfolio(path: string, idToken: string, debugLog: string[]): Promise<{ items: RacionalPortfolioItem[]; balance: number }> {
  debugLog.push(`4. Fetching portfolio from ${path}...`);
  const res = await firestoreGet(path, idToken);
  if (!res.ok || !res.data.documents) {
    debugLog.push("  No portfolio documents found");
    return { items: [], balance: 0 };
  }

  const items: RacionalPortfolioItem[] = [];
  let totalBalance = 0;

  for (const doc of res.data.documents) {
    const f = doc.fields;
    const name = String(fsVal(f.name) || fsVal(f.title) || fsVal(f.label) || doc.name.split("/").pop() || "");
    const value = Number(fsVal(f.value) || fsVal(f.balance) || fsVal(f.nav) || fsVal(f.amount) || fsVal(f.total) || 0);
    const id = doc.name.split("/").pop() || "";

    items.push({ id, name, value, currency: String(fsVal(f.currency) || "CLP") });
    totalBalance += value;
  }

  debugLog.push(`  Found ${items.length} position(s), balance: $${Math.round(totalBalance).toLocaleString("es-CL")}`);
  return { items, balance: totalBalance };
}

async function fetchMovements(path: string, idToken: string, debugLog: string[]): Promise<BankMovement[]> {
  debugLog.push(`5. Fetching movements from ${path}...`);
  const res = await firestoreGet(path, idToken);
  if (!res.ok || !res.data.documents) {
    debugLog.push("  No movement documents found");
    return [];
  }

  const movements: BankMovement[] = [];
  for (const doc of res.data.documents) {
    const f = doc.fields;
    const rawDate = String(fsVal(f.date) || fsVal(f.createdAt) || fsVal(f.timestamp) || fsVal(f.fecha) || "");
    const date = normalizeDate(rawDate.split("T")[0]);
    const description = String(fsVal(f.description) || fsVal(f.desc) || fsVal(f.type) || fsVal(f.descripcion) || "Movimiento");
    const rawAmount = Number(fsVal(f.amount) || fsVal(f.monto) || fsVal(f.value) || 0);
    const type = String(fsVal(f.type) || fsVal(f.tipo) || "").toLowerCase();

    const isNegative = ["withdrawal", "purchase", "fee", "retiro", "compra", "comision", "rescate"].includes(type);
    const amount = isNegative ? -Math.abs(rawAmount) : Math.abs(rawAmount);
    if (amount === 0) continue;

    movements.push({ date, description, amount, balance: 0, source: MOVEMENT_SOURCE.account });
  }

  debugLog.push(`  Found ${movements.length} movement(s)`);
  return movements;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeRacional(options: ScraperOptions, debugLog: string[]): Promise<ScrapeResult> {
  const { rut: email, password, onProgress } = options;
  const bank = "racional";
  const progress = onProgress || (() => {});

  progress("Conectando con Racional...");

  // Try to restore a saved session (refresh token) before full login
  let idToken = "";
  let refreshToken = "";
  if (options.onTwoFactorCode) {
    // Check if there's a stored session we can refresh
    // (The web app passes stored tokens via the session mechanism)
  }

  // Firebase Auth: email + password → idToken
  const authResult = await firebaseSignIn(email, password, debugLog);
  if (!authResult.success) {
    return { success: false, bank, movements: [], error: authResult.error, debug: debugLog.join("\n") };
  }
  idToken = authResult.idToken;
  refreshToken = authResult.refreshToken;

  progress("Sesión iniciada correctamente");

  // Discover Firestore data — user doc + subcollections
  const { portfolioPath, movementsPath, userDoc } = await discoverData(authResult.localId, idToken, debugLog);

  // Try subcollections first, then fall back to embedded user doc fields
  let portfolio: RacionalPortfolioItem[] = [];
  let balance = 0;

  if (portfolioPath) {
    const result = await fetchPortfolio(portfolioPath, idToken, debugLog);
    portfolio = result.items;
    balance = result.balance;
  } else if (userDoc) {
    // Extract portfolio from embedded user doc fields
    debugLog.push("4. Extracting portfolio from user document...");
    const f = userDoc.fields;
    // Look for portfolio-related fields
    for (const key of Object.keys(f)) {
      const val = f[key];
      if (val.arrayValue?.values) {
        // Array field — could be portfolio items
        for (const item of val.arrayValue.values) {
          if (item.mapValue?.fields) {
            const mf = item.mapValue.fields;
            const name = String(fsVal(mf.name) || fsVal(mf.assetId) || fsVal(mf.ticker) || key);
            const value = Number(fsVal(mf.value) || fsVal(mf.balance) || fsVal(mf.amount) || fsVal(mf.clpValue) || fsVal(mf.totalValue) || 0);
            if (value > 0) {
              portfolio.push({ id: name, name, value, currency: "CLP" });
              balance += value;
            }
          }
        }
      } else if (val.mapValue?.fields) {
        // Check for balance/portfolio map
        const mf = val.mapValue.fields;
        const possibleBalance = Number(fsVal(mf.balance) || fsVal(mf.total) || fsVal(mf.clpBalance) || fsVal(mf.totalBalance) || 0);
        if (possibleBalance > 0 && !balance) {
          balance = possibleBalance;
          debugLog.push(`  Balance from ${key}: $${Math.round(balance).toLocaleString("es-CL")}`);
        }
      }
    }
    // Also check direct balance fields
    const directBalance = Number(fsVal(f.balance) || fsVal(f.totalBalance) || fsVal(f.clpBalance) || fsVal(f.portfolioValue) || 0);
    if (directBalance > 0 && !balance) balance = directBalance;

    if (portfolio.length > 0) {
      debugLog.push(`  Found ${portfolio.length} position(s) in user doc, balance: $${Math.round(balance).toLocaleString("es-CL")}`);
    }
  }

  const movements = movementsPath
    ? await fetchMovements(movementsPath, idToken, debugLog)
    : [];

  // Fallback: portfolio balance snapshots if no transaction history
  let allMovements = movements;
  if (movements.length === 0 && portfolio.length > 0) {
    debugLog.push("  No movement history — creating portfolio balance snapshots");
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const dateStr = `${dd}-${mm}-${yyyy}`;

    allMovements = portfolio.map(p => ({
      date: dateStr,
      description: `${p.name} (${p.id})`,
      amount: Math.round(p.value),
      balance: Math.round(p.value),
      source: MOVEMENT_SOURCE.account,
    }));
  }

  const deduplicated = deduplicateMovements(allMovements);
  debugLog.push(`5. Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  // Persist tokens for next run
  const sessionCookies = JSON.stringify({ idToken, refreshToken, localId: authResult.localId });

  return {
    success: true, bank, movements: deduplicated,
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
