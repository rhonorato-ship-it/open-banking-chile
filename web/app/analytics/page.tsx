"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Navigation from "@/components/Navigation";
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
  fintual: "Fintual", itau: "Itaú", mach: "MACH", mercadopago: "MP",
  racional: "Racional", santander: "Santander", scotiabank: "Scotiabank",
  tenpo: "Tenpo",
};

const BANK_COLORS = ["#0f766e", "#10b981", "#f43f5e", "#8b5cf6", "#f97316", "#ec4899", "#06b6d4", "#eab308"];

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

  const chartData = (data?.timeSeries ?? []).map((ts) => ({
    name: monthLabel(ts.month),
    Ingresos: ts.income,
    Egresos: ts.spend,
  }));

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

  const heatMonths = [...new Set((data?.heatmap ?? []).map((h) => h.month))].sort();
  const topCats = data?.topCategories ?? [];
  const heatmapCell = (month: string, cat: string): number => {
    return data?.heatmap.find((h) => h.month === month && h.category === cat)?.amount ?? 0;
  };
  const catMaxes: Record<string, number> = {};
  for (const cat of topCats) {
    catMaxes[cat] = Math.max(...heatMonths.map((m) => heatmapCell(m, cat)), 1);
  }

  const maxSpend = data?.categoryBreakdown[0]?.amount ?? 1;
  const s = data?.summaryTotals;
  const allBanks = bankIds.length > 0 ? bankIds : [];

  return (
    <div className="min-h-screen">
      <Navigation />

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        {/* Header + filter bar */}
        <div className="flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Analítica</h1>
            <p className="text-slate-400 text-sm mt-1">
              {loading ? "Cargando…" : "Sin transferencias internas"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {allBanks.length > 1 && (
              <select
                value={bankFilter}
                onChange={(e) => setBankFilter(e.target.value)}
                className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-500 focus:outline-none focus:border-teal-400 transition-colors"
              >
                <option value="">Todos los bancos</option>
                {allBanks.map((b) => <option key={b} value={b}>{BANK_NAMES[b] ?? b}</option>)}
              </select>
            )}
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-500 focus:outline-none focus:border-teal-400 transition-colors" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-500 focus:outline-none focus:border-teal-400 transition-colors" />
            {(from || to || bankFilter) && (
              <button
                onClick={() => { setFrom(""); setTo(""); setBankFilter(""); }}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors px-2"
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
              <div key={i} className="p-4 rounded-2xl border border-slate-200 bg-white">
                <div className="h-2.5 w-16 bg-slate-200 rounded-full mb-3" />
                <div className="h-6 w-24 bg-slate-100 rounded-lg" />
              </div>
            ))}
          </div>
        ) : s && (s.totalSpend > 0 || s.totalIncome > 0) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Total egresos</p>
              <p className="text-lg font-bold font-[family-name:var(--font-geist-mono)] text-rose-600">{fmt(s.totalSpend)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Total ingresos</p>
              <p className="text-lg font-bold font-[family-name:var(--font-geist-mono)] text-emerald-600">{fmt(s.totalIncome)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Balance neto</p>
              <p className={`text-lg font-bold font-[family-name:var(--font-geist-mono)] ${s.netPosition >= 0 ? "text-teal-700" : "text-rose-600"}`}>
                {fmt(s.netPosition)}
              </p>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Gasto mensual prom.</p>
              <p className="text-lg font-bold font-[family-name:var(--font-geist-mono)] text-slate-600">{fmt(s.avgMonthlySpend)}</p>
            </div>
          </div>
        )}

        {/* Time series chart */}
        <div className="p-5 rounded-2xl border border-slate-200 bg-white">
          <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-5">Ingresos vs Egresos</p>
          {loading ? (
            <div className="h-48 animate-pulse flex items-end gap-2 px-2">
              {[60, 85, 45, 90, 70, 55, 80, 65].map((h, i) => (
                <div key={i} className="flex-1 bg-slate-100 rounded-sm" style={{ height: `${h}%` }} />
              ))}
            </div>
          ) : chartData.length < 2 ? (
            <p className="text-slate-400 text-sm py-12 text-center">Sin suficientes datos</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barGap={2} barCategoryGap="28%">
                <CartesianGrid vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtShort} tick={{ fill: "#cbd5e1", fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, fontSize: 12, color: "#475569" }}
                  labelStyle={{ color: "#94a3b8", marginBottom: 4 }}
                  formatter={(value) => [fmt(Number(value)), ""]}
                  cursor={{ fill: "rgba(15,118,110,0.04)" }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8", paddingTop: 8 }} />
                <Bar dataKey="Ingresos" fill="#10b981" fillOpacity={0.7} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Egresos" fill="#f43f5e" fillOpacity={0.7} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Bank comparison */}
        {!loading && bankChartData.length >= 2 && bankIds.length >= 2 && (
          <div className="p-5 rounded-2xl border border-slate-200 bg-white">
            <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-5">Egresos por banco</p>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={bankChartData}>
                <CartesianGrid vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtShort} tick={{ fill: "#cbd5e1", fontSize: 10 }} axisLine={false} tickLine={false} width={44} />
                <Tooltip
                  contentStyle={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 12, fontSize: 12, color: "#475569" }}
                  labelStyle={{ color: "#94a3b8", marginBottom: 4 }}
                  formatter={(value) => [fmt(Number(value)), ""]}
                  cursor={{ stroke: "#e2e8f0" }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8", paddingTop: 8 }} />
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
        <div className="p-5 rounded-2xl border border-slate-200 bg-white">
          <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-5">Gastos por categoría</p>
          {loading ? (
            <div className="space-y-4 animate-pulse">
              {[100, 80, 65, 50, 40, 30].map((w, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-2.5 w-28 bg-slate-100 rounded-full shrink-0" />
                  <div className="flex-1 h-1.5 bg-slate-100 rounded-full" style={{ maxWidth: `${w}%` }} />
                  <div className="h-2.5 w-20 bg-slate-100 rounded-full shrink-0" />
                </div>
              ))}
            </div>
          ) : !data?.categoryBreakdown.length ? (
            <p className="text-slate-400 text-sm py-8 text-center">Sin datos de categorías</p>
          ) : (
            <div className="space-y-3.5">
              {data.categoryBreakdown.map((c) => (
                <div key={c.category} className="flex items-center gap-3">
                  <span className="text-sm text-slate-500 w-32 shrink-0 truncate">
                    {CATEGORY_NAMES[c.category] ?? c.category}
                  </span>
                  <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-teal-500 rounded-full" style={{ width: `${(c.amount / maxSpend) * 100}%`, opacity: 0.7 }} />
                  </div>
                  <span className="text-sm font-[family-name:var(--font-geist-mono)] text-slate-400 w-28 text-right shrink-0">{fmt(c.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Spending heatmap */}
        {!loading && heatMonths.length >= 2 && topCats.length >= 2 && (
          <div className="p-5 rounded-2xl border border-slate-200 bg-white overflow-x-auto">
            <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-5">Mapa de calor — mes × categoría</p>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>
                  <th className="text-left text-slate-400 font-normal pr-3 pb-2 whitespace-nowrap w-14">Mes</th>
                  {topCats.map((cat) => (
                    <th key={cat} className="text-center text-slate-400 font-normal pb-2 px-1 whitespace-nowrap">
                      {CATEGORY_NAMES[cat] ?? cat}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatMonths.map((month) => (
                  <tr key={month}>
                    <td className="text-slate-400 pr-3 py-1 whitespace-nowrap">{monthLabel(month)}</td>
                    {topCats.map((cat) => {
                      const amount = heatmapCell(month, cat);
                      const intensity = amount > 0 ? (amount / catMaxes[cat]) : 0;
                      const bg = intensity > 0
                        ? `rgba(15,118,110,${(0.08 + intensity * 0.42).toFixed(2)})`
                        : "transparent";
                      return (
                        <td
                          key={cat}
                          className="px-1 py-1 text-center rounded"
                          title={amount > 0 ? fmt(amount) : "—"}
                        >
                          <div
                            className="rounded mx-auto"
                            style={{ background: bg, width: "100%", minWidth: 28, height: 22, lineHeight: "22px", color: intensity > 0.5 ? "white" : "#64748b" }}
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
