import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { encrypt } from "@/lib/credentials";
import { normalizeRut } from "@/lib/rut";
import { isValidIsoDate } from "@/lib/utils";
import { listBanks } from "open-banking-chile";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const allBanks = listBanks();

  const { data: saved } = await supabase
    .from("bank_credentials")
    .select("id, bank_id, last_synced_at, is_syncing")
    .eq("user_id", userId);

  // Latest balance per bank: fetch movements with balance, deduplicate by bank_id in JS
  const { data: balanceRows } = await supabase
    .from("movements")
    .select("bank_id, balance, date, synced_at")
    .eq("user_id", userId)
    .not("balance", "is", null)
    .order("date", { ascending: false })
    .order("synced_at", { ascending: false });

  const balanceMap: Record<string, number> = {};
  for (const row of balanceRows ?? []) {
    if (!(row.bank_id in balanceMap)) {
      balanceMap[row.bank_id] = parseFloat(row.balance);
    }
  }

  // 30-day net change per bank
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString().slice(0, 10);
  if (!isValidIsoDate(sinceIso)) {
    return NextResponse.json({ error: "Invalid server date" }, { status: 500 });
  }

  const { data: changeRows } = await supabase
    .from("movements")
    .select("bank_id, amount")
    .eq("user_id", userId)
    .gte("date", sinceIso);

  const changeMap: Record<string, number> = {};
  for (const row of changeRows ?? []) {
    changeMap[row.bank_id] = (changeMap[row.bank_id] ?? 0) + parseFloat(row.amount);
  }

  const savedMap = Object.fromEntries((saved ?? []).map((c) => [c.bank_id, c]));
  return NextResponse.json(
    allBanks.map((b) => ({
      ...b,
      connected: !!savedMap[b.id],
      lastSyncedAt: savedMap[b.id]?.last_synced_at ?? null,
      isSyncing: savedMap[b.id]?.is_syncing ?? false,
      balance: balanceMap[b.id] ?? null,
      change30d: changeMap[b.id] ?? null,
    })),
  );
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const { bankId, rut, password } = (body ?? {}) as {
    bankId?: unknown;
    rut?: unknown;
    password?: unknown;
  };

  if (typeof bankId !== "string" || typeof rut !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
  }

  const normalizedBankId = bankId.trim();
  if (!normalizedBankId || !password) {
    return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
  }

  // Banks that use email, username, or token instead of RUT — skip RUT validation
  const NON_RUT_BANKS = new Set(["fintual", "racional", "mercadopago", "citi"]);
  const normalizedRut = NON_RUT_BANKS.has(normalizedBankId) ? rut.trim() : normalizeRut(rut);
  if (!normalizedRut) {
    return NextResponse.json({ error: "RUT inválido" }, { status: 400 });
  }

  const allBanks = listBanks();
  if (!allBanks.some((b) => b.id === normalizedBankId)) {
    return NextResponse.json({ error: "Unknown bank" }, { status: 400 });
  }

  const userId = session.user.id;
  const encRut = await encrypt(normalizedRut);
  const encPass = await encrypt(password);

  const { error } = await supabase.from("bank_credentials").upsert(
    {
      user_id: userId,
      bank_id: normalizedBankId,
      encrypted_rut: encRut.ciphertext,
      rut_iv: encRut.iv,
      encrypted_password: encPass.ciphertext,
      password_iv: encPass.iv,
    },
    { onConflict: "user_id,bank_id" },
  );

  if (error) return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const bankId = typeof (body as { bankId?: unknown })?.bankId === "string"
    ? (body as { bankId: string }).bankId.trim()
    : "";

  if (!bankId) {
    return NextResponse.json({ error: "Missing or invalid bankId" }, { status: 400 });
  }

  await supabase
    .from("bank_credentials")
    .delete()
    .eq("user_id", session.user.id)
    .eq("bank_id", bankId);

  return NextResponse.json({ ok: true });
}
