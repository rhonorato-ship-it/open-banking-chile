export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { decrypt } from "@/lib/credentials";
import crypto from "crypto";

/**
 * GET /api/agent/credentials?bankId=bice
 *
 * Returns decrypted { rut, password } for the authenticated user + bank.
 * Auth: Bearer token (agent JWT signed with AUTH_SECRET).
 */
export async function GET(req: Request) {
  // ── Verify JWT ────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  let userId: string;
  try {
    userId = verifyAgentJWT(token, secret);
  } catch {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  // ── Read bankId from query ────────────────────────────────────
  const url = new URL(req.url);
  const bankId = url.searchParams.get("bankId");
  if (!bankId) {
    return NextResponse.json({ error: "Missing bankId query parameter" }, { status: 400 });
  }

  // ── Fetch and decrypt credentials ─────────────────────────────
  const { data: cred, error: credError } = await supabase
    .from("bank_credentials")
    .select("encrypted_rut, rut_iv, encrypted_password, password_iv")
    .eq("user_id", userId)
    .eq("bank_id", bankId)
    .single();

  if (credError || !cred) {
    return NextResponse.json({ error: "No credentials found for this bank" }, { status: 404 });
  }

  const rut = await decrypt(cred.encrypted_rut, cred.rut_iv);
  const password = await decrypt(cred.encrypted_password, cred.password_iv);

  return NextResponse.json({ rut, password });
}

// ── JWT verification ──────────────────────────────────────────────

function base64urlDecode(input: string): Buffer {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64");
}

/**
 * Verify an HS256 JWT signed with AUTH_SECRET.
 * Returns the `sub` (userId) on success; throws on failure.
 */
function verifyAgentJWT(token: string, secret: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();
  const actualSig = base64urlDecode(signatureB64);

  if (!crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error("Invalid signature");
  }

  // Parse payload
  const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf-8"));

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error("Token expired");
  }

  if (!payload.sub) {
    throw new Error("Missing sub claim");
  }

  return payload.sub as string;
}
