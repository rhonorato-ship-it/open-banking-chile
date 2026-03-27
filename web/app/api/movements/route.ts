import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { isValidIsoDate } from "@/lib/utils";
import { inferCategory } from "@/lib/categories";
import { detectInternalTransferIds } from "@/lib/transfers";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const bankId = searchParams.get("bankId")?.trim();
  const from = searchParams.get("from")?.trim();
  const to = searchParams.get("to")?.trim();

  if (from && !isValidIsoDate(from)) {
    return NextResponse.json({ error: "Invalid 'from' date format. Expected YYYY-MM-DD." }, { status: 400 });
  }
  if (to && !isValidIsoDate(to)) {
    return NextResponse.json({ error: "Invalid 'to' date format. Expected YYYY-MM-DD." }, { status: 400 });
  }

  let query = supabase
    .from("movements")
    .select("id, bank_id, date, description, amount, balance, source")
    .eq("user_id", session.user.id)
    .order("date", { ascending: false })
    .limit(500);

  if (bankId) query = query.eq("bank_id", bankId);
  if (from) query = query.gte("date", from);
  if (to) query = query.lte("date", to);

  const { data: rows, error } = await query;
  if (error) return NextResponse.json({ error: "Failed to fetch movements" }, { status: 500 });

  const movements = (rows ?? []).map((r) => ({
    id: r.id,
    bank_id: r.bank_id,
    date: r.date,
    description: r.description,
    amount: Number(r.amount),
  }));

  const transferIds = detectInternalTransferIds(movements);

  return NextResponse.json(
    movements.map((m, i) => ({
      id: m.id,
      bankId: m.bank_id,
      date: m.date,
      description: m.description,
      amount: rows![i].amount,
      balance: rows![i].balance,
      source: rows![i].source,
      category: inferCategory(m.description),
      isInternalTransfer: transferIds.has(m.id),
    })),
  );
}
