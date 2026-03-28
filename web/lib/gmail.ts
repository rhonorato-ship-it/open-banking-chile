// Gmail API client for 2FA code extraction.
// Uses fetch() directly (no googleapis library) to keep bundle lightweight.

import { supabase } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/credentials";

// ---------------------------------------------------------------------------
// Bank-specific 2FA email patterns
// ---------------------------------------------------------------------------

export const BANK_2FA_PATTERNS: Record<string, { query: string; codeRegex: RegExp }> = {
  racional: { query: "from:@racional.cl newer_than:5m", codeRegex: /\b\d{6}\b/ },
  citi: { query: "from:@citi.com newer_than:5m", codeRegex: /\b\d{6}\b/ },
  bestado: { query: "from:@bancoestado.cl newer_than:5m", codeRegex: /\b\d{6}\b/ },
  falabella: { query: "from:@bancofalabella.cl newer_than:5m", codeRegex: /\b\d{4,6}\b/ },
  scotiabank: { query: "from:@scotiabank.cl newer_than:5m", codeRegex: /\b\d{6}\b/ },
  bice: { query: "from:@bice.cl newer_than:5m", codeRegex: /\b\d{6}\b/ },
  itau: { query: "from:@itau.cl newer_than:5m", codeRegex: /\b\d{6}\b/ },
  bci: { query: "from:@bci.cl newer_than:5m", codeRegex: /\b\d{6}\b/ },
};

const GENERIC_QUERY = "subject:(código OR verificación OR OTP OR code) newer_than:2m";

// ---------------------------------------------------------------------------
// OAuth2 helpers
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/** Exchange a refresh token for a fresh access token. */
async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

/** Retrieve and decrypt the user's stored Gmail refresh token. */
async function getRefreshToken(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("gmail_refresh_token, gmail_token_iv")
      .eq("id", userId)
      .single();

    if (error || !data?.gmail_refresh_token || !data?.gmail_token_iv) return null;

    return await decrypt(data.gmail_refresh_token, data.gmail_token_iv);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gmail API calls
// ---------------------------------------------------------------------------

interface GmailListResponse {
  messages?: { id: string; threadId: string }[];
  resultSizeEstimate?: number;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  payload?: GmailMessagePart;
}

/** Decode base64url-encoded string (Gmail uses URL-safe base64). */
function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/** Recursively extract all text/plain and text/html body parts from a message. */
function extractBodyText(part: GmailMessagePart): string {
  const chunks: string[] = [];

  if (part.body?.data) {
    chunks.push(decodeBase64Url(part.body.data));
  }

  if (part.parts) {
    for (const child of part.parts) {
      chunks.push(extractBodyText(child));
    }
  }

  return chunks.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search Gmail for a 2FA code from a specific bank.
 * Returns the first matching code, or null if not found.
 */
export async function searchFor2FACode(userId: string, bankId: string): Promise<string | null> {
  const refreshToken = await getRefreshToken(userId);
  if (!refreshToken) return null;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(refreshToken);
  } catch (e) {
    console.error("[gmail] access token error:", e);
    return null;
  }

  const pattern = BANK_2FA_PATTERNS[bankId];
  const query = pattern?.query ?? GENERIC_QUERY;
  const codeRegex = pattern?.codeRegex ?? /\b\d{6}\b/;

  // Step 1: Search for matching messages
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("maxResults", "5");

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listRes.ok) {
    console.error("[gmail] list messages failed:", listRes.status);
    return null;
  }

  const listData = (await listRes.json()) as GmailListResponse;
  if (!listData.messages?.length) return null;

  // Step 2: Check each message for the code
  for (const msg of listData.messages) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!msgRes.ok) continue;

    const msgData = (await msgRes.json()) as GmailMessage;
    if (!msgData.payload) continue;

    const bodyText = extractBodyText(msgData.payload);
    const match = bodyText.match(codeRegex);
    if (match) return match[0];
  }

  return null;
}

/** Check whether the user has a Gmail refresh token stored. */
export async function isGmailConnected(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("gmail_refresh_token")
      .eq("id", userId)
      .single();

    return !error && !!data?.gmail_refresh_token;
  } catch {
    return false;
  }
}

/** Remove the stored Gmail token for a user. */
export async function disconnectGmail(userId: string): Promise<void> {
  try {
    await supabase
      .from("users")
      .update({ gmail_refresh_token: null, gmail_token_iv: null, agentic_mode: false })
      .eq("id", userId);
  } catch (e) {
    console.error("[gmail] disconnect error:", e);
  }
}

/** Store an encrypted Gmail refresh token for a user. */
export async function storeGmailToken(userId: string, refreshToken: string): Promise<void> {
  const { ciphertext, iv } = await encrypt(refreshToken);
  const { error } = await supabase
    .from("users")
    .update({ gmail_refresh_token: ciphertext, gmail_token_iv: iv })
    .eq("id", userId);

  if (error) {
    console.error("[gmail] store token error:", error);
    throw new Error("Failed to store Gmail token");
  }
}
