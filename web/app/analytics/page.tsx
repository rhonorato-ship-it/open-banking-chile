"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from "recharts";

interface TimeSeries { month: string; spend: number; income: number }
interface CategoryItem { category: string; amount: number }
interface SummaryTotals { totalSpend: number; totalIncome: number; netPosition: number; avgMonthlySpend: number }
interface BankSeriesItem { month: string; bankId: string; spend: number }
interface HeatmapItem { month: string; category: string; amount: number }

interface AnalyticsData {
  timeSeries: TimeSeries[];
  categoryBreakdown: CategoryItem[];
  summaryTotals: SummaryTotals;
  bankSeries: BankSeriesItem[];
  heatmap: HeatmapItem[];
  topCategories: string[];
}

const CATEGORY_NAMES: Record<string, string> = {
  income: "Ingresos", housing: "Vivienda", groceries: "Supermercado",
  eating_out: "Restaurantes", transport: "Transporte", health: "Salud",
  entertainment: "Entretenim.", utilities: "Servicios", education: "Educación",
  shopping: "Shopping", savings_investment: "Inversiones", insurance: "Seguros",
  transfer: "Transferencias", cash: "Efectivo", other: "Otros",
};

const BANK_NAMES: Record<string, string> = {
  bchile: "B. Chile", bci: "BCI", bestado: "BancoEstado", bice: "BICE",
  citi: "Citi", edwards: "Edwards", falabella: "Falabella",
  itau: "Itaú", santander: "Santander", scotiabank: "Scotiabank",
};

const BANK_COLORS = ["#0ea5e9", "#34d399", "#f87171", "#a78bfa", "#fb923c", "#e879f9", "#22d3ee", "#facc15"];

const MONTHS_ES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

function monthLabel(m: string) {
  return MONTHS_ES[parseInt(m.slice(5, 7), 10) - 1] + " '" + m.slice(2, 4);
}

const fmt = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

function fmtShort(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [bankFilter, setBankFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (bankFilter) params.set("bankId", bankFilter);
    const res = await fetch(`/api/analytics?${params}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [from, to, bankFilter]);

  useEffect(() => { load(); }, [load]);

  // Build recharts-friendly datasets
  const chartData = (data?.timeSeries ?? []).map((ts) => ({
    name: monthLabel(ts.month),
    Ingresos: ts.income,
    Egresos: ts.spend,
  }));

  // Bank comparison: pivot bankSeries → { name: month, [bankId]: spend }[]
  const bankIds = [...new Set((data?.bankSeries ?? []).map((b) => b.bankId))];
  const bankChartData = (() => {
    const map = new Map<string, Record<string, number>>();
    for (const item of data?.bankSeries ?? []) {
      const row = map.get(item.month) ?? {};
      row[item.bankId] = item.spend;
      map.set(item.month, row);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, vals]) => ({ name: monthLabel(month), ...vals }));
  })();

  // Heatmap: months × topCategories
  const heatMonths = [...new Set((data?.heatmap ?? []).map((h) => h.month))].sort();
  const topCats = data?.topCategories ?? [];
  const heatmapCell = (month: string, cat: string): number => {
    return data?.heatmap.find((h) => h.month === month && h.category === cat)?.amount ?? 0;
  };
  // max per category column for intensity
  const catMaxes: Record<string, number> = {};
  for (const cat of topCats) {
    catMaxes[cat] = Math.max(...heatMonths.map((m) => heatmapCell(m, cat)), 1);
  }

  const maxSpend = data?.categoryBreakdown[0]?.amount ?? 1;
  const s = data?.summaryTotals;

  // All bank IDs that appear in movements (for filter dropdown)
  const allBanks = bankIds.length > 0 ? bankIds : [];

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <nav className="border-b border-white/[0.06] px-6 h-14 flex items-center justify-between sticky top-0 bg-[#08080f]/90 backdrop-blur-sm z-10">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-5 h-5 rounded-full bg-[#0ea5e9]" />
          <span className="font-semibold text-sm tracking-tight">Open Banking Chile</span>
        </Link>
        <div className="flex items-center gap-5">
          <Link href="/movements" className="text-sm text-white/40 hover:text-white/80 transition-colors">Movimientos</Link>
          <Link href="/banks" className="text-sm text-white/40 hover:text-white/80 transition-colors">Cuentas</Link>
          <Link href="/dashboard" className="text-sm text-white/40 hover:text-white/80 transition-colors">Dashboard</Link>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">

        {/* Header + filter bar */}
        <div className="flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
          <div>
            <Link href="/dashboard" className="text-xs text-white/25 hover:text-white/60 mb-2 block transition-colors">← Volver</Link>
            <h1 className="text-2xl font-bold">Analítica</h1>
            <p className="text-white/30 text-sm mt-1">
              {loading ? "Cargando…" : "Sin transferencias internas"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {allBanks.length > 1 && (
              <select
                value={bankFilter}
                onChange={(e) => setBankFilter(e.target.value)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/60 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors"
              >
                <option value="">Todos los bancos</option>
                {allBanks.map((b) => <option key={b} value={b}>{BANK_NAMES[b] ?? b}</option>)}
              </select>
            )}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/60 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/60 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors" />
            {(from || to || bankFilter) && (
              <button
                onClick={() => { setFrom(""); setTo(""); setBankFilter(""); }}
                className="text-xs text-white/30 hover:text-white/60 transition-colors px-2"
              >
                Limpiar ×
              </button>
            )}
          </div>
        </div>

        {/* Summary totals */}
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-pulse">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
                <div className="h-2.5 w-16 bg-white/[0.06] rounded-full mb-3" />
                <div className="h-6 w-24 bg-white/[0.06] rounded-lg" />
              </div>
            ))}
          </div>
        ) : s && (s.totalSpend > 0 || s.totalIncome > 0) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Total egresos</p>
              <p className="text-lg font-bold font-mono text-red-400">{fmt(s.totalSpend)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Total ingresos</p>
              <p className="text-lg font-bold font-mono text-emerald-400">{fmt(s.totalIncome)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Balance neto</p>
              <p className={`text-lg font-bold font-mono ${s.netPosition >= 0 ? "text-[#0ea5e9]" : "text-red-400"}`}>
                {fmt(s.netPosition)}
              </p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Gasto mensual prom.</p>
              <p className="text-lg font-bold font-mono text-white/70">{fmt(s.avgMonthlySpend)}</p>
            </div>
          </div>
        )}

        {/* Time series chart */}
        <div className="p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
          <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-5">Ingresos vs Egresos</p>
          {loading ? (
            <div className="h-48 animate-pulse flex items-end gap-2 px-2">
              {[60, 85, 45, 90, 70, 55, 80, 65].map((h, i) => (
                <div key={i} className="flex-1 bg-white/[0.05] rounded-sm" style={{ height: `${h}%` }} />
              ))}
            </div>
          ) : chartData.length < 2 ? (
            <p className="text-white/20 text-sm py-12 text-center">Sin suficientes datos</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barGap={2} barCategoryGap="28%">
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtShort} tick={{ fill: "rgba(255,255,255,0.20)", fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "#111118", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, fontSize: 12, color: "rgba(255,255,255,0.7)" }}
                  labelStyle={{ color: "rgba(255,255,255,0.4)", marginBottom: 4 }}
                  formatter={(value) => [fmt(Number(value)), ""]}
                  cursor={{ fill: "rgba(255,255,255,0.025)" }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.3)", paddingTop: 8 }} />
                <Bar dataKey="Ingresos" fill="#34d399" fillOpacity={0.55} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Egresos" fill="#f87171" fillOpacity={0.55} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Bank comparison */}
        {!loading && bankChartData.length >= 2 && bankIds.length >= 2 && (
          <div className="p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
            <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-5">Egresos por banco</p>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={bankChartData}>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtShort} tick={{ fill: "rgba(255,255,255,0.20)", fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "#111118", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, fontSize: 12, color: "rgba(255,255,255,0.7)" }}
                  labelStyle={{ color: "rgba(255,255,255,0.4)", marginBottom: 4 }}
                  formatter={(value) => [fmt(Number(value)), ""]}
                  cursor={{ stroke: "rgba(255,255,255,0.06)" }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.3)", paddingTop: 8 }} />
                {bankIds.map((bid, i) => (
                  <Line
                    key={bid}
                    type="monotone"
                    dataKey={bid}
                    name={BANK_NAMES[bid] ?? bid}
                    stroke={BANK_COLORS[i % BANK_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    strokeOpacity={0.8}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Category breakdown */}
        <div className="p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
          <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-5">Gastos por categoría</p>
          {loading ? (
            <div className="space-y-4 animate-pulse">
              {[100, 80, 65, 50, 40, 30].map((w, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-2.5 w-28 bg-white/[0.06] rounded-full shrink-0" />
                  <div className="flex-1 h-1.5 bg-white/[0.04] rounded-full" style={{ maxWidth: `${w}%` }} />
                  <div className="h-2.5 w-20 bg-white/[0.06] rounded-full shrink-0" />
                </div>
              ))}
            </div>
          ) : !data?.categoryBreakdown.length ? (
            <p className="text-white/20 text-sm py-8 text-center">Sin datos de categorías</p>
          ) : (
            <div className="space-y-3.5">
              {data.categoryBreakdown.map((c) => (
                <div key={c.category} className="flex items-center gap-3">
                  <span className="text-sm text-white/50 w-32 shrink-0 truncate">
                    {CATEGORY_NAMES[c.category] ?? c.category}
                  </span>
                  <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                    <div className="h-full bg-[#0ea5e9]/40 rounded-full" style={{ width: `${(c.amount / maxSpend) * 100}%` }} />
                  </div>
                  <span className="text-sm font-mono text-white/40 w-28 text-right shrink-0">{fmt(c.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Spending heatmap */}
        {!loading && heatMonths.length >= 2 && topCats.length >= 2 && (
          <div className="p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03] overflow-x-auto">
            <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-5">Mapa de calor — mes × categoría</p>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-white/20 font-normal pr-3 pb-2 whitespace-nowrap w-14">Mes</th>
                  {topCats.map((cat) => (
                    <th key={cat} className="text-center text-white/20 font-normal pb-2 px-1 whitespace-nowrap">
                      {CATEGORY_NAMES[cat] ?? cat}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatMonths.map((month) => (
                  <tr key={month}>
                    <td className="text-white/30 pr-3 py-1 whitespace-nowrap">{monthLabel(month)}</td>
                    {topCats.map((cat) => {
                      const amount = heatmapCell(month, cat);
                      const intensity = amount > 0 ? (amount / catMaxes[cat]) : 0;
                      const bg = intensity > 0
                        ? `rgba(14,165,233,${(0.08 + intensity * 0.52).toFixed(2)})`
                        : "transparent";
                      return (
                        <td
                          key={cat}
                          className="px-1 py-1 text-center rounded"
                          title={amount > 0 ? fmt(amount) : "—"}
                        >
                          <div
                            className="rounded mx-auto"
                            style={{ background: bg, width: "100%", minWidth: 28, height: 22, lineHeight: "22px", color: intensity > 0.5 ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.3)" }}
                          >
                            {amount > 0 ? fmtShort(amount) : ""}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
