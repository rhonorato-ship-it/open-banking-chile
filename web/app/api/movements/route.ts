import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { movements } from "@/lib/schema";
import { and, desc, eq, gte, lte } from "drizzle-orm";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const bankId = searchParams.get("bankId");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const filters = [eq(movements.userId, session.user.id)];
  if (bankId) filters.push(eq(movements.bankId, bankId));
  if (from) filters.push(gte(movements.date, from));
  if (to) filters.push(lte(movements.date, to));

  const rows = await db.query.movements.findMany({
    where: and(...filters),
    orderBy: [desc(movements.date)],
    limit: 500,
  });

  return NextResponse.json(rows);
}
