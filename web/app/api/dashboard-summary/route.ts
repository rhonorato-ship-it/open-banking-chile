import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { inferCategory } from "@/lib/categories";
import { detectInternalTransferIds } from "@/lib/transfers";

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

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

  // Monthly series — last 6 months (all movements excl. transfers)
  const seriesMap = new Map<string, { month: string; spend: number; income: number }>();
  // Category breakdown — current month only
  const categoryMap = new Map<string, number>();

  let monthlySpend = 0;
  let monthlyIncome = 0;
  let transferCount = 0;

  for (const m of movements) {
    const isTransfer = transferIds.has(m.id);
    const month = monthKey(m.date);

    // Count transfer pairs (each pair has 2 entries — divide by 2 later)
    if (isTransfer) {
      if (m.date.startsWith(thisMonth) && m.amount < 0) transferCount++;
      continue;
    }

    // Time series (last 6 months)
    const ts = seriesMap.get(month) ?? { month, spend: 0, income: 0 };
    if (m.amount < 0) ts.spend += Math.abs(m.amount);
    else ts.income += m.amount;
    seriesMap.set(month, ts);

    // Current month aggregates
    if (month === thisMonth) {
      if (m.amount < 0) {
        monthlySpend += Math.abs(m.amount);
        const cat = categoryMap.get(m.category) ?? 0;
        categoryMap.set(m.category, cat + Math.abs(m.amount));
      } else {
        monthlyIncome += m.amount;
      }
    }
  }

  const monthlySeries = Array.from(seriesMap.values()).slice(-6);

  const categoryBreakdown = Array.from(categoryMap.entries())
    .map(([category, amount]) => ({ category, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  return NextResponse.json({
    monthlySpend: Math.round(monthlySpend),
    monthlyIncome: Math.round(monthlyIncome),
    monthlyNet: Math.round(monthlyIncome - monthlySpend),
    transferCount,
    categoryBreakdown,
    monthlySeries,
  });
}
