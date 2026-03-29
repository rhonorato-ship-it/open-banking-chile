export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import crypto from "crypto";

/**
 * GET /api/agent/credentials/list
 *
 * Returns all connected bank IDs for the authenticated user.
 * No credentials are returned -- just the list of bank_id values.
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

  // ── Fetch connected banks ─────────────────────────────────────
  const { data: rows, error } = await supabase
    .from("bank_credentials")
    .select("bank_id")
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch bank list" }, { status: 500 });
  }

  const bankIds = (rows ?? []).map((r: { bank_id: string }) => r.bank_id);

  return NextResponse.json({ banks: bankIds });
}

// ── JWT verification (same as credentials/route.ts) ──────────────

function base64urlDecode(input: string): Buffer {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return Buffer.from(base64, "base64");
}

function verifyAgentJWT(token: string, secret: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const [headerB64, payloadB64, signatureB64] = parts;

  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();
  const actualSig = base64urlDecode(signatureB64);

  if (!crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error("Invalid signature");
  }

  const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf-8"));

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error("Token expired");
  }

  if (!payload.sub) {
    throw new Error("Missing sub claim");
  }

  return payload.sub as string;
}
