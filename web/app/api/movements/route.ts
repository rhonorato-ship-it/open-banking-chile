import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { isValidIsoDate } from "@/lib/utils";

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

  // Map snake_case DB columns to camelCase for the frontend
  return NextResponse.json(
    (rows ?? []).map((r) => ({
      id: r.id,
      bankId: r.bank_id,
      date: r.date,
      description: r.description,
      amount: r.amount,
      balance: r.balance,
      source: r.source,
    })),
  );
}
