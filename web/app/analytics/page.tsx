"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface TimeSeries {
  month: string;
  spend: number;
  income: number;
}

interface CategoryItem {
  category: string;
  amount: number;
}

interface AnalyticsData {
  timeSeries: TimeSeries[];
  categoryBreakdown: CategoryItem[];
}

const CATEGORY_NAMES: Record<string, string> = {
  income: "Ingresos",
  housing: "Vivienda",
  groceries: "Supermercado",
  eating_out: "Restaurantes",
  transport: "Transporte",
  health: "Salud",
  entertainment: "Entretenimiento",
  utilities: "Servicios",
  education: "Educación",
  shopping: "Shopping",
  savings_investment: "Inversiones",
  insurance: "Seguros",
  transfer: "Transferencias",
  cash: "Efectivo",
  other: "Otros",
};

const MONTHS_ES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

function monthLabel(m: string) {
  const month = parseInt(m.slice(5, 7), 10);
  return MONTHS_ES[month - 1] + " '" + m.slice(2, 4);
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

  useEffect(() => {
    fetch("/api/analytics")
      .then((r) => r.json())
      .then((d: AnalyticsData) => { setData(d); setLoading(false); });
  }, []);

  const chartData = (data?.timeSeries ?? []).map((ts) => ({
    name: monthLabel(ts.month),
    Ingresos: ts.income,
    Egresos: ts.spend,
  }));

  const maxSpend = data?.categoryBreakdown.length
    ? Math.max(...data.categoryBreakdown.map((c) => c.amount))
    : 1;

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

      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="mb-8">
          <Link href="/dashboard" className="text-xs text-white/25 hover:text-white/60 mb-2 block transition-colors">
            ← Volver
          </Link>
          <h1 className="text-2xl font-bold">Analítica</h1>
          <p className="text-white/30 text-sm mt-1">
            {loading ? "Cargando…" : "Últimos 12 meses · sin transferencias internas"}
          </p>
        </div>

        {/* Time series chart */}
        <div className="mb-6 p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
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
                <XAxis
                  dataKey="name"
                  tick={{ fill: "rgba(255,255,255,0.25)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={fmtShort}
                  tick={{ fill: "rgba(255,255,255,0.20)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={44}
                />
                <Tooltip
                  contentStyle={{
                    background: "#111118",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 12,
                    fontSize: 12,
                    color: "rgba(255,255,255,0.7)",
                  }}
                  labelStyle={{ color: "rgba(255,255,255,0.4)", marginBottom: 4 }}
                  formatter={(value) => [fmt(Number(value)), ""]}
                  cursor={{ fill: "rgba(255,255,255,0.025)" }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.3)", paddingTop: 8 }}
                />
                <Bar dataKey="Ingresos" fill="#34d399" fillOpacity={0.55} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Egresos" fill="#f87171" fillOpacity={0.55} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

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
                    <div
                      className="h-full bg-[#0ea5e9]/40 rounded-full"
                      style={{ width: `${(c.amount / maxSpend) * 100}%` }}
                    />
                  </div>
                  <span className="text-sm font-mono text-white/40 w-28 text-right shrink-0">
                    {fmt(c.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
