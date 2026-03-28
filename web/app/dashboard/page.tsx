"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import Navigation from "@/components/Navigation";
import ScrapeProgress from "@/components/ScrapeProgress";

interface BankStatus {
  id: string;
  name: string;
  connected: boolean;
  lastSyncedAt: string | null;
  isSyncing: boolean;
  balance: number | null;
  change30d: number | null;
}

interface DashboardSummary {
  monthlySpend: number;
  monthlyIncome: number;
  monthlyNet: number;
  transferCount: number;
  categoryBreakdown: Array<{ category: string; amount: number }>;
  monthlySeries: Array<{ month: string; spend: number; income: number }>;
}

interface CoachRec {
  id: string;
  title: string;
  rationale: string;
  action: string;
  estimatedImpactClp: number;
}

const CATEGORY_NAMES: Record<string, string> = {
  income: "Ingresos", housing: "Vivienda", groceries: "Supermercado",
  eating_out: "Restaurantes", transport: "Transporte", health: "Salud",
  entertainment: "Entretenimiento", utilities: "Servicios", education: "Educación",
  shopping: "Shopping", savings_investment: "Inversiones", insurance: "Seguros",
  transfer: "Transferencias", cash: "Efectivo", other: "Otros",
};

const MONTHS_ES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];

const BANK_THEME: Record<string, { border: string; bg: string; accent: string; text: string }> = {
  itau:       { border: "border-orange-300",  bg: "bg-orange-50",  accent: "bg-orange-500",  text: "text-orange-700" },
  santander:  { border: "border-red-300",     bg: "bg-red-50",     accent: "bg-red-500",     text: "text-red-700" },
  bice:       { border: "border-blue-300",    bg: "bg-blue-50",    accent: "bg-blue-500",    text: "text-blue-700" },
  bchile:     { border: "border-emerald-300", bg: "bg-emerald-50", accent: "bg-emerald-600", text: "text-emerald-700" },
  bci:        { border: "border-purple-300",  bg: "bg-purple-50",  accent: "bg-purple-500",  text: "text-purple-700" },
  bestado:    { border: "border-teal-300",    bg: "bg-teal-50",    accent: "bg-teal-600",    text: "text-teal-700" },
  scotiabank: { border: "border-rose-300",    bg: "bg-rose-50",    accent: "bg-rose-500",    text: "text-rose-700" },
  fintual:    { border: "border-violet-300",  bg: "bg-violet-50",  accent: "bg-violet-500",  text: "text-violet-700" },
  racional:   { border: "border-cyan-300",    bg: "bg-cyan-50",    accent: "bg-cyan-600",    text: "text-cyan-700" },
  citi:       { border: "border-sky-300",     bg: "bg-sky-50",     accent: "bg-sky-500",     text: "text-sky-700" },
  falabella:  { border: "border-lime-300",    bg: "bg-lime-50",    accent: "bg-lime-600",    text: "text-lime-700" },
  edwards:    { border: "border-amber-300",   bg: "bg-amber-50",   accent: "bg-amber-500",   text: "text-amber-700" },
  mercadopago:{ border: "border-indigo-300",  bg: "bg-indigo-50",  accent: "bg-indigo-500",  text: "text-indigo-700" },
  tenpo:      { border: "border-pink-300",    bg: "bg-pink-50",    accent: "bg-pink-500",    text: "text-pink-700" },
  mach:       { border: "border-fuchsia-300", bg: "bg-fuchsia-50", accent: "bg-fuchsia-500", text: "text-fuchsia-700" },
};
const DEFAULT_THEME = { border: "border-slate-300", bg: "bg-slate-50", accent: "bg-slate-500", text: "text-slate-700" };

const fmt = (n: number) =>
  new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);

const fmtDate = (s: string) =>
  new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(s));

export default function DashboardPage() {
  const [banks, setBanks] = useState<BankStatus[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [coach, setCoach] = useState<CoachRec[]>([]);
  const [scraping, setScraping] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [agenticMode, setAgenticMode] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailLoading, setGmailLoading] = useState(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  async function loadBanks() {
    const res = await fetch("/api/banks");
    if (res.ok) setBanks(await res.json());
    setLoading(false);
  }

  async function loadSummary() {
    const res = await fetch("/api/dashboard-summary");
    if (res.ok) setSummary(await res.json());
  }

  async function loadCoach() {
    const res = await fetch("/api/coach");
    if (res.ok) {
      const { recommendations } = await res.json();
      setCoach(recommendations ?? []);
    }
  }

  async function loadGmailStatus() {
    try {
      const res = await fetch("/api/gmail/status");
      if (res.ok) {
        const data = await res.json();
        setGmailConnected(data.connected ?? false);
        setAgenticMode(data.agenticMode ?? false);
      }
    } catch {
      // Gmail endpoints may not exist yet — default to off
    } finally {
      setGmailLoading(false);
    }
  }

  async function toggleAgenticMode(enabled: boolean) {
    setAgenticMode(enabled);
    try {
      await fetch("/api/gmail/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      setAgenticMode(!enabled);
    }
  }

  async function disconnectGmail() {
    try {
      const res = await fetch("/api/gmail/disconnect", { method: "POST" });
      if (res.ok) {
        setGmailConnected(false);
        setAgenticMode(false);
        showToast("Gmail desconectado");
      }
    } catch {
      showToast("Error al desconectar Gmail");
    }
  }

  useEffect(() => {
    loadBanks();
    loadSummary();
    loadCoach();
    loadGmailStatus();
  }, []);

  const connected = banks.filter((b) => b.connected);
  const available = banks.filter((b) => !b.connected);
  const totalBalance = connected.reduce((s, b) => s + (b.balance ?? 0), 0);
  const hasBalance = connected.some((b) => b.balance !== null);

  const maxSeries = summary
    ? Math.max(...summary.monthlySeries.flatMap((m) => [m.income, m.spend]), 1)
    : 1;
  const maxCategory = summary?.categoryBreakdown[0]?.amount ?? 1;

  return (
    <div className="min-h-screen">
      <Navigation />

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">

        {/* ── Vista 360 — Cuentas ── */}
        {loading ? (
          <section className="animate-pulse space-y-4">
            <div className="h-4 w-48 bg-slate-200 rounded-full" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="p-5 rounded-2xl border border-slate-200 bg-white">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-slate-200" />
                    <div className="flex-1">
                      <div className="h-3 w-20 bg-slate-200 rounded-full mb-2" />
                      <div className="h-2.5 w-14 bg-slate-100 rounded-full" />
                    </div>
                  </div>
                  <div className="h-7 w-32 bg-slate-200 rounded-lg mb-4" />
                  <div className="h-8 w-full bg-slate-100 rounded-xl" />
                </div>
              ))}
            </div>
          </section>
        ) : connected.length > 0 ? (
          <section>
            <div className="flex items-baseline justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Vista 360 — Cuentas</h2>
                {hasBalance && (
                  <p className="text-sm text-slate-400 mt-0.5">
                    Balance total: <span className="font-mono font-semibold text-slate-700">{fmt(totalBalance)}</span>
                  </p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {connected.map((b) => {
                const theme = BANK_THEME[b.id] ?? DEFAULT_THEME;
                return (
                  <div key={b.id} className={`p-5 rounded-2xl border-2 ${theme.border} ${theme.bg} flex flex-col gap-3`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl ${theme.accent} flex items-center justify-center text-sm font-bold text-white`}>
                          {b.name[0]}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{b.name}</p>
                          <p className="text-xs text-slate-400">
                            {b.lastSyncedAt ? fmtDate(b.lastSyncedAt) : "Sin sincronizar"}
                          </p>
                        </div>
                      </div>
                      <div className="w-2 h-2 rounded-full bg-emerald-500" title="Conectado" />
                    </div>

                    {b.balance !== null && (
                      <p className="text-2xl font-[family-name:var(--font-geist-mono)] font-bold tracking-tight text-slate-900">
                        {fmt(b.balance)}
                      </p>
                    )}

                    {b.change30d !== null && b.change30d !== 0 && (
                      <p className={`text-xs font-medium ${b.change30d > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                        {b.change30d > 0 ? "↑" : "↓"} {fmt(Math.abs(b.change30d))} este mes
                      </p>
                    )}

                    <div className="flex gap-2 mt-auto">
                      <button
                        onClick={() => setScraping({ id: b.id, name: b.name })}
                        className={`flex-1 py-2 rounded-xl ${theme.accent} text-white text-xs font-bold hover:opacity-90 transition-opacity`}
                      >
                        Sincronizar
                      </button>
                      <Link
                        href={`/movements?bankId=${b.id}`}
                        className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-400 hover:text-slate-700 hover:border-slate-300 transition-colors bg-white"
                      >
                        Ver
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : available.length > 0 ? (
          <section className="text-center py-12">
            <div className="w-12 h-12 rounded-2xl bg-teal-50 border border-teal-200 flex items-center justify-center mx-auto mb-4">
              <span className="text-teal-600 text-lg">+</span>
            </div>
            <h2 className="text-lg font-bold text-slate-900 mb-1">Conecta un banco</h2>
            <p className="text-sm text-slate-400 mb-4">Agrega tus credenciales para empezar a sincronizar.</p>
          </section>
        ) : (
          <div className="text-center py-20">
            <p className="text-slate-400 text-sm">No hay bancos disponibles.</p>
          </div>
        )}

        {/* ── Summary Cards ── */}
        {loading || !summary ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-pulse">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="p-4 rounded-2xl border border-slate-200 bg-white">
                <div className="h-2.5 w-16 bg-slate-200 rounded-full mb-3" />
                <div className="h-6 w-24 bg-slate-100 rounded-lg" />
              </div>
            ))}
          </div>
        ) : summary.monthlySpend > 0 || summary.monthlyIncome > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Caja disponible</p>
              <p className="text-lg font-bold font-[family-name:var(--font-geist-mono)] text-teal-700">
                {hasBalance ? fmt(totalBalance) : "—"}
              </p>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Gasto mensual</p>
              <p className="text-lg font-bold font-[family-name:var(--font-geist-mono)] text-rose-600">{fmt(summary.monthlySpend)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Ingreso mensual</p>
              <p className="text-lg font-bold font-[family-name:var(--font-geist-mono)] text-emerald-600">{fmt(summary.monthlyIncome)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-slate-200 bg-white">
              <p className="text-xs text-slate-400 mb-1">Traspasos internos</p>
              <p className="text-lg font-bold font-[family-name:var(--font-geist-mono)] text-slate-400">{summary.transferCount}</p>
            </div>
          </div>
        ) : null}

        {/* ── Monthly Chart + Categories ── */}
        {summary && (summary.monthlySeries.length >= 2 || summary.categoryBreakdown.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {summary.monthlySeries.length >= 2 && (
              <div className="p-5 rounded-2xl border border-slate-200 bg-white">
                <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-5">Últimos 6 meses</p>
                <div className="flex items-end gap-2" style={{ height: 72 }}>
                  {summary.monthlySeries.map((m) => {
                    const incH = Math.max(3, (m.income / maxSeries) * 72);
                    const spH = Math.max(3, (m.spend / maxSeries) * 72);
                    const label = MONTHS_ES[parseInt(m.month.slice(5, 7), 10) - 1] + " '" + m.month.slice(2, 4);
                    return (
                      <div key={m.month} className="flex-1 flex flex-col items-center justify-end gap-0.5">
                        <div className="w-full flex items-end justify-center gap-0.5" style={{ height: 72 }}>
                          <div
                            className="flex-1 rounded-sm bg-emerald-400 hover:bg-emerald-500 transition-colors"
                            style={{ height: incH, opacity: 0.6 }}
                            title={`Ingresos: ${fmt(m.income)}`}
                          />
                          <div
                            className="flex-1 rounded-sm bg-rose-400 hover:bg-rose-500 transition-colors"
                            style={{ height: spH, opacity: 0.6 }}
                            title={`Egresos: ${fmt(m.spend)}`}
                          />
                        </div>
                        <span className="text-[9px] text-slate-300 mt-1.5 whitespace-nowrap">{label}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-4 mt-4">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-sm bg-emerald-400" />
                    <span className="text-[10px] text-slate-400">Ingresos</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-sm bg-rose-400" />
                    <span className="text-[10px] text-slate-400">Egresos</span>
                  </div>
                </div>
              </div>
            )}

            {summary.categoryBreakdown.length > 0 && (
              <div className="p-5 rounded-2xl border border-slate-200 bg-white">
                <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-5">Gastos este mes</p>
                <div className="space-y-3">
                  {summary.categoryBreakdown.map((c) => (
                    <div key={c.category} className="flex items-center gap-3">
                      <span className="text-sm text-slate-500 w-28 shrink-0 truncate">
                        {CATEGORY_NAMES[c.category] ?? c.category}
                      </span>
                      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-teal-500 rounded-full"
                          style={{ width: `${(c.amount / maxCategory) * 100}%`, opacity: 0.7 }}
                        />
                      </div>
                      <span className="text-xs font-[family-name:var(--font-geist-mono)] text-slate-400 w-24 text-right shrink-0">
                        {fmt(c.amount)}
                      </span>
                    </div>
                  ))}
                </div>
                <Link href="/analytics" className="mt-4 block text-xs text-teal-600 hover:text-teal-700 transition-colors text-right">
                  Ver analítica completa →
                </Link>
              </div>
            )}
          </div>
        )}

        {/* ── Coach Recommendations ── */}
        {coach.length > 0 && (
          <div className="p-5 rounded-2xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs text-slate-400 uppercase tracking-[0.15em]">Coach</p>
                <p className="text-xs text-slate-300 mt-0.5">Recomendaciones del mes</p>
              </div>
            </div>
            <div className="space-y-3">
              {coach.slice(0, 2).map((rec) => (
                <div key={rec.id} className="flex gap-3 p-3 rounded-xl bg-teal-50/50 border border-teal-100">
                  <div className="w-7 h-7 rounded-lg bg-teal-100 border border-teal-200 flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-teal-600 text-sm">→</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 leading-snug">{rec.title}</p>
                    <p className="text-xs text-slate-400 mt-0.5 leading-snug">{rec.action}</p>
                  </div>
                  {rec.estimatedImpactClp > 0 && (
                    <div className="shrink-0 text-right">
                      <p className="text-[10px] text-slate-300">ahorro est.</p>
                      <p className="text-xs font-[family-name:var(--font-geist-mono)] text-emerald-600">
                        {fmt(rec.estimatedImpactClp)}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Available Banks ── */}
        {!loading && available.length > 0 && (
          <section>
            <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">Bancos disponibles</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
              {available.map((b) => {
                const theme = BANK_THEME[b.id] ?? DEFAULT_THEME;
                return (
                  <Link
                    key={b.id}
                    href={`/banks?add=${b.id}`}
                    className="group flex items-center gap-2.5 px-3 py-3 rounded-xl border border-slate-200 hover:border-teal-300 bg-white hover:bg-teal-50/50 transition-all"
                  >
                    <div className={`w-7 h-7 rounded-lg ${theme.bg} border ${theme.border} flex items-center justify-center text-xs font-bold ${theme.text} shrink-0`}>
                      {b.name[0]}
                    </div>
                    <p className="text-xs text-slate-400 group-hover:text-slate-600 transition-colors truncate">{b.name}</p>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Agentic Mode ── */}
        {!loading && !gmailLoading && (
          <section className="flex items-center justify-between gap-4 px-4 py-3 rounded-2xl border border-slate-200 bg-white">
            <div className="flex items-center gap-3 min-w-0">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <button
                  type="button"
                  role="switch"
                  aria-checked={agenticMode}
                  onClick={() => toggleAgenticMode(!agenticMode)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${agenticMode ? "bg-teal-600" : "bg-slate-200"}`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${agenticMode ? "translate-x-[18px]" : "translate-x-[3px]"}`}
                  />
                </button>
                <span className="text-sm text-slate-500">Sincronización agéntica</span>
              </label>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {agenticMode && !gmailConnected && (
                <a
                  href="/api/gmail/connect"
                  className="px-3 py-1.5 rounded-lg border border-teal-200 text-xs text-teal-600 hover:bg-teal-50 transition-colors"
                >
                  Conecta Gmail
                </a>
              )}
              {agenticMode && gmailConnected && (
                <>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-xs text-emerald-600">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Gmail conectado
                  </span>
                  <button
                    onClick={disconnectGmail}
                    className="text-xs text-slate-300 hover:text-slate-500 transition-colors"
                  >
                    Desconectar
                  </button>
                </>
              )}
            </div>
          </section>
        )}
      </main>

      {scraping && (
        <ScrapeProgress
          bankId={scraping.id}
          bankName={scraping.name}
          agentic={agenticMode && gmailConnected}
          onDone={() => { setScraping(null); loadBanks(); loadSummary(); loadCoach(); showToast(`${scraping.name} sincronizado`); }}
          onError={() => { setScraping(null); loadBanks(); }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-white border border-slate-200 shadow-lg rounded-full px-5 py-2.5 text-sm font-medium text-slate-700 pointer-events-none">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          {toast}
        </div>
      )}
    </div>
  );
}
