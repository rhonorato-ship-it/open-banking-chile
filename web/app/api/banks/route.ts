import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bankCredentials, movements } from "@/lib/schema";
import { encrypt } from "@/lib/credentials";
import { listBanks } from "open-banking-chile";
import { and, eq, gte, sql, sum } from "drizzle-orm";

function isValidIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const allBanks = listBanks();
  const saved = await db.query.bankCredentials.findMany({
    where: eq(bankCredentials.userId, userId),
    columns: { id: true, bankId: true, lastSyncedAt: true, isSyncing: true },
  });

  // Latest balance per bank (most recent movement that has a balance)
  const latestBalances = await db.execute(sql`
    SELECT DISTINCT ON (bank_id) bank_id, balance
    FROM movements
    WHERE user_id = ${userId} AND balance IS NOT NULL
    ORDER BY bank_id, date DESC, synced_at DESC
  `);
  const balanceMap: Record<string, number> = {};
  for (const row of latestBalances as unknown as { bank_id: string; balance: string }[]) {
    balanceMap[row.bank_id] = parseFloat(row.balance);
  }

  // 30-day net change per bank
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString().slice(0, 10);
  if (!isValidIsoDate(sinceIso)) {
    return NextResponse.json({ error: "Invalid server date" }, { status: 500 });
  }

  const changes = await db
    .select({ bankId: movements.bankId, change: sum(movements.amount) })
    .from(movements)
    .where(and(eq(movements.userId, userId), gte(movements.date, sinceIso)))
    .groupBy(movements.bankId);
  const changeMap: Record<string, number> = Object.fromEntries(
    changes.map((r) => [r.bankId, parseFloat(r.change ?? "0")])
  );

  const savedMap = Object.fromEntries(saved.map((c) => [c.bankId, c]));
  return NextResponse.json(
    allBanks.map((b) => ({
      ...b,
      connected: !!savedMap[b.id],
      lastSyncedAt: savedMap[b.id]?.lastSyncedAt ?? null,
      isSyncing: savedMap[b.id]?.isSyncing ?? false,
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
  const normalizedRut = rut.trim();
  if (!normalizedBankId || !normalizedRut || !password) {
    return NextResponse.json({ error: "Missing or invalid fields" }, { status: 400 });
  }

  const allBanks = listBanks();
  if (!allBanks.some((b) => b.id === normalizedBankId)) {
    return NextResponse.json({ error: "Unknown bank" }, { status: 400 });
  }

  const userId = session.user.id;
  const encRut = await encrypt(normalizedRut);
  const encPass = await encrypt(password);

  await db
    .insert(bankCredentials)
    .values({
      userId,
      bankId: normalizedBankId,
      encryptedRut: encRut.ciphertext,
      rutIv: encRut.iv,
      encryptedPassword: encPass.ciphertext,
      passwordIv: encPass.iv,
    })
    .onConflictDoUpdate({
      target: [bankCredentials.userId, bankCredentials.bankId],
      set: {
        encryptedRut: encRut.ciphertext,
        rutIv: encRut.iv,
        encryptedPassword: encPass.ciphertext,
        passwordIv: encPass.iv,
      },
    });

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

  await db
    .delete(bankCredentials)
    .where(and(eq(bankCredentials.userId, session.user.id), eq(bankCredentials.bankId, bankId)));

  return NextResponse.json({ ok: true });
}
