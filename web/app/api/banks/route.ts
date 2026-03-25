import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bankCredentials, movements } from "@/lib/schema";
import { encrypt } from "@/lib/credentials";
import { listBanks } from "open-banking-chile";
import { and, eq, gte, sql, sum } from "drizzle-orm";

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
  for (const row of latestBalances as { bank_id: string; balance: string }[]) {
    balanceMap[row.bank_id] = parseFloat(row.balance);
  }

  // 30-day net change per bank
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const changes = await db
    .select({ bankId: movements.bankId, change: sum(movements.amount) })
    .from(movements)
    .where(and(eq(movements.userId, userId), gte(movements.date, since.toISOString().slice(0, 10))))
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

  const { bankId, rut, password } = await req.json();
  if (!bankId || !rut || !password) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const userId = session.user.id;
  const encRut = await encrypt(rut);
  const encPass = await encrypt(password);

  await db
    .insert(bankCredentials)
    .values({
      userId,
      bankId,
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

  const { bankId } = await req.json();
  await db
    .delete(bankCredentials)
    .where(and(eq(bankCredentials.userId, session.user.id), eq(bankCredentials.bankId, bankId)));

  return NextResponse.json({ ok: true });
}
