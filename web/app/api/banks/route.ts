import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { bankCredentials } from "@/lib/schema";
import { encrypt } from "@/lib/credentials";
import { listBanks } from "open-banking-chile";
import { and, eq } from "drizzle-orm";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.user.id;
  const allBanks = listBanks();
  const saved = await db.query.bankCredentials.findMany({
    where: eq(bankCredentials.userId, userId),
    columns: { id: true, bankId: true, lastSyncedAt: true, isSyncing: true },
  });

  const savedMap = Object.fromEntries(saved.map((c) => [c.bankId, c]));
  return NextResponse.json(
    allBanks.map((b) => ({
      ...b,
      connected: !!savedMap[b.id],
      lastSyncedAt: savedMap[b.id]?.lastSyncedAt ?? null,
      isSyncing: savedMap[b.id]?.isSyncing ?? false,
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
