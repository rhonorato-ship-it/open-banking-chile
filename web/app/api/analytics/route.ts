import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { inferCategory } from "@/lib/categories";
import { detectInternalTransferIds } from "@/lib/transfers";

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: rows, error } = await supabase
    .from("movements")
    .select("id, bank_id, date, description, amount")
    .eq("user_id", session.user.id)
    .order("date", { ascending: true })
    .limit(2000);

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

  // Time series: month → { spend, income }
  const timeSeriesMap = new Map<string, { month: string; spend: number; income: number }>();
  // Category breakdown: category → amount
  const categoryMap = new Map<string, number>();

  for (const m of movements) {
    if (transferIds.has(m.id)) continue; // exclude internal transfers

    const month = monthKey(m.date);
    const ts = timeSeriesMap.get(month) ?? { month, spend: 0, income: 0 };
    if (m.amount < 0) {
      ts.spend += Math.abs(m.amount);
      const cat = categoryMap.get(m.category) ?? 0;
      categoryMap.set(m.category, cat + Math.abs(m.amount));
    } else {
      ts.income += m.amount;
    }
    timeSeriesMap.set(month, ts);
  }

  const timeSeries = Array.from(timeSeriesMap.values()).slice(-12); // last 12 months

  const categoryBreakdown = Array.from(categoryMap.entries())
    .map(([category, amount]) => ({ category, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  return NextResponse.json({ timeSeries, categoryBreakdown });
}
