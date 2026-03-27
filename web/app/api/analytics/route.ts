import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { inferCategory } from "@/lib/categories";
import { detectInternalTransferIds } from "@/lib/transfers";
import { isValidIsoDate } from "@/lib/utils";

function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "YYYY-MM"
}

const TOP_CATEGORIES = 8;
const TOP_BREAKDOWN = 10;

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const bankId = searchParams.get("bankId")?.trim() || null;
  const from = searchParams.get("from")?.trim() || null;
  const to = searchParams.get("to")?.trim() || null;

  if (from && !isValidIsoDate(from)) {
    return NextResponse.json({ error: "Invalid 'from' date format. Expected YYYY-MM-DD." }, { status: 400 });
  }
  if (to && !isValidIsoDate(to)) {
    return NextResponse.json({ error: "Invalid 'to' date format. Expected YYYY-MM-DD." }, { status: 400 });
  }

  let query = supabase
    .from("movements")
    .select("id, bank_id, date, description, amount")
    .eq("user_id", session.user.id)
    .order("date", { ascending: true })
    .limit(2000);

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
    category: inferCategory(r.description),
  }));

  const transferIds = detectInternalTransferIds(movements);

  // Aggregation maps
  const timeSeriesMap = new Map<string, { month: string; spend: number; income: number }>();
  const categoryMap = new Map<string, number>();
  // bank → month → spend
  const bankMonthMap = new Map<string, Map<string, number>>();
  // month → category → spend (for heatmap)
  const heatmapMap = new Map<string, Map<string, number>>();

  let totalSpend = 0;
  let totalIncome = 0;

  for (const m of movements) {
    if (transferIds.has(m.id)) continue;

    const month = monthKey(m.date);

    const ts = timeSeriesMap.get(month) ?? { month, spend: 0, income: 0 };
    if (m.amount < 0) {
      const abs = Math.abs(m.amount);
      ts.spend += abs;
      totalSpend += abs;

      // Category breakdown
      categoryMap.set(m.category, (categoryMap.get(m.category) ?? 0) + abs);

      // Bank series
      if (!bankMonthMap.has(m.bank_id)) bankMonthMap.set(m.bank_id, new Map());
      const bankMap = bankMonthMap.get(m.bank_id)!;
      bankMap.set(month, (bankMap.get(month) ?? 0) + abs);

      // Heatmap
      if (!heatmapMap.has(month)) heatmapMap.set(month, new Map());
      const mMap = heatmapMap.get(month)!;
      mMap.set(m.category, (mMap.get(m.category) ?? 0) + abs);
    } else {
      ts.income += m.amount;
      totalIncome += m.amount;
    }
    timeSeriesMap.set(month, ts);
  }

  const timeSeries = Array.from(timeSeriesMap.values()).slice(-12);
  const monthCount = timeSeries.length || 1;

  const categoryBreakdown = Array.from(categoryMap.entries())
    .map(([category, amount]) => ({ category, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, TOP_BREAKDOWN);

  const summaryTotals = {
    totalSpend: Math.round(totalSpend),
    totalIncome: Math.round(totalIncome),
    netPosition: Math.round(totalIncome - totalSpend),
    avgMonthlySpend: Math.round(totalSpend / monthCount),
  };

  // Bank series — each entry: { month, bankId, spend }
  const bankSeries: Array<{ month: string; bankId: string; spend: number }> = [];
  for (const [bid, monthMap] of bankMonthMap.entries()) {
    for (const [month, spend] of monthMap.entries()) {
      bankSeries.push({ month, bankId: bid, spend: Math.round(spend) });
    }
  }
  bankSeries.sort((a, b) => a.month.localeCompare(b.month));

  // Heatmap — top N categories × all months
  const topCategories = Array.from(categoryMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CATEGORIES)
    .map(([cat]) => cat);

  const heatmap: Array<{ month: string; category: string; amount: number }> = [];
  for (const [month, catMap] of heatmapMap.entries()) {
    for (const cat of topCategories) {
      const amount = catMap.get(cat) ?? 0;
      heatmap.push({ month, category: cat, amount: Math.round(amount) });
    }
  }
  heatmap.sort((a, b) => a.month.localeCompare(b.month) || topCategories.indexOf(a.category) - topCategories.indexOf(b.category));

  return NextResponse.json({
    timeSeries,
    categoryBreakdown,
    summaryTotals,
    bankSeries,
    heatmap,
    topCategories,
  });
}
