import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { inferCategory } from "@/lib/categories";
import { detectInternalTransferIds } from "@/lib/transfers";
import { getCoachRecommendations } from "@/lib/coach";

function currentMonthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: rows, error } = await supabase
    .from("movements")
    .select("id, bank_id, date, description, amount")
    .eq("user_id", session.user.id)
    .order("date", { ascending: true })
    .limit(500);

  if (error) return NextResponse.json({ error: "Failed to fetch movements" }, { status: 500 });

  const movements = (rows ?? []).map((r) => ({
    id: r.id,
    bank_id: r.bank_id,
    date: r.date,
    description: r.description,
    amount: Number(r.amount),
    category: inferCategory(r.description),
  }));

  const transferIds = detectInternalTransferIds(movements);
  const thisMonth = currentMonthKey();

  let monthlySpend = 0;
  let monthlyIncome = 0;
  let transferCount = 0;
  const categoryMap = new Map<string, number>();

  for (const m of movements) {
    if (!m.date.startsWith(thisMonth)) continue;
    if (transferIds.has(m.id)) {
      if (m.amount < 0) transferCount++;
      continue;
    }
    if (m.amount < 0) {
      const abs = Math.abs(m.amount);
      monthlySpend += abs;
      categoryMap.set(m.category, (categoryMap.get(m.category) ?? 0) + abs);
    } else {
      monthlyIncome += m.amount;
    }
  }

  const categoryBreakdown = Array.from(categoryMap.entries())
    .map(([category, amount]) => ({ category, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const recommendations = getCoachRecommendations({
    monthlySpend: Math.round(monthlySpend),
    monthlyIncome: Math.round(monthlyIncome),
    transferCount,
    categoryBreakdown,
  });

  return NextResponse.json({ recommendations });
}
