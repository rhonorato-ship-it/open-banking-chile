import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import crypto from "crypto";

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error("[agent/token] AUTH_SECRET not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const userId = session.user.id;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 365 * 24 * 60 * 60; // 365 days

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: userId,
    role: "authenticated",
    iss: "open-banking-chile-agent",
    iat: now,
    exp,
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];

  const signingInput = segments.join(".");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();

  const token = signingInput + "." + base64url(signature);

  return NextResponse.json({ token });
}
