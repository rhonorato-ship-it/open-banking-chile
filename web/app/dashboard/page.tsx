"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
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
      setAgenticMode(!enabled); // revert on error
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
  const totalChange = connected.reduce((s, b) => s + (b.change30d ?? 0), 0);
  const hasBalance = connected.some((b) => b.balance !== null);

  const maxSeries = summary
    ? Math.max(...summary.monthlySeries.flatMap((m) => [m.income, m.spend]), 1)
    : 1;
  const maxCategory = summary?.categoryBreakdown[0]?.amount ?? 1;

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 h-14 flex items-center justify-between sticky top-0 bg-[#08080f]/90 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2.5">
          <div className="w-5 h-5 rounded-full bg-[#0ea5e9]" />
          <span className="font-semibold text-sm tracking-tight">Open Banking Chile</span>
        </div>
        <div className="flex items-center gap-5">
          <Link href="/movements" className="text-sm text-white/40 hover:text-white/80 transition-colors">Movimientos</Link>
          <Link href="/analytics" className="text-sm text-white/40 hover:text-white/80 transition-colors">Analítica</Link>
          <Link href="/banks" className="text-sm text-white/40 hover:text-white/80 transition-colors">Cuentas</Link>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="text-sm text-white/30 hover:text-white/60 transition-colors"
          >
            Salir
          </button>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-10">

        {/* ── Balance Hero ── */}
        {loading ? (
          <section className="animate-pulse">
            <div className="h-3 w-24 bg-white/[0.06] rounded-full mb-4" />
            <div className="h-12 w-56 bg-white/[0.06] rounded-xl mb-6" />
            <div className="flex gap-2">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="h-12 w-36 bg-white/[0.04] rounded-2xl" />
              ))}
            </div>
          </section>
        ) : connected.length > 0 && (
          <section>
            <p className="text-xs text-white/30 uppercase tracking-[0.15em] mb-3">Balance total</p>
            <div className="flex flex-wrap items-end gap-3 mb-6">
              <span className="text-5xl font-bold tracking-tight font-mono">
                {hasBalance ? fmt(totalBalance) : "—"}
              </span>
              {hasBalance && totalChange !== 0 && (
                <span className={`mb-1 text-sm font-medium px-2.5 py-1 rounded-full ${totalChange > 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                  {totalChange > 0 ? "↑" : "↓"} {fmt(Math.abs(totalChange))} este mes
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {connected.map((b) => (
                <div key={b.id} className="flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-white/[0.04] border border-white/[0.07]">
                  <div className="w-6 h-6 rounded-lg bg-[#0ea5e9]/15 flex items-center justify-center text-[10px] font-bold text-[#0ea5e9]">
                    {b.name[0]}
                  </div>
                  <div>
                    <p className="text-[11px] text-white/35 leading-none mb-0.5">{b.name}</p>
                    <p className="text-sm font-mono font-semibold leading-none">{b.balance !== null ? fmt(b.balance) : "—"}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Monthly Summary Cards ── */}
        {loading || !summary ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-pulse">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
                <div className="h-2.5 w-16 bg-white/[0.06] rounded-full mb-3" />
                <div className="h-6 w-24 bg-white/[0.06] rounded-lg" />
              </div>
            ))}
          </div>
        ) : summary.monthlySpend > 0 || summary.monthlyIncome > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Gasto mensual</p>
              <p className="text-lg font-bold font-mono text-red-400">{fmt(summary.monthlySpend)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Ingreso mensual</p>
              <p className="text-lg font-bold font-mono text-emerald-400">{fmt(summary.monthlyIncome)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Balance neto</p>
              <p className={`text-lg font-bold font-mono ${summary.monthlyNet >= 0 ? "text-[#0ea5e9]" : "text-red-400"}`}>
                {fmt(summary.monthlyNet)}
              </p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Traspasos internos</p>
              <p className="text-lg font-bold font-mono text-white/50">{summary.transferCount}</p>
            </div>
          </div>
        ) : null}

        {/* ── Mini Chart + Categories ── */}
        {summary && (summary.monthlySeries.length >= 2 || summary.categoryBreakdown.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Monthly mini-chart */}
            {summary.monthlySeries.length >= 2 && (
              <div className="p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
                <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-5">Últimos 6 meses</p>
                <div className="flex items-end gap-2" style={{ height: 72 }}>
                  {summary.monthlySeries.map((m) => {
                    const incH = Math.max(3, (m.income / maxSeries) * 72);
                    const spH = Math.max(3, (m.spend / maxSeries) * 72);
                    const label = MONTHS_ES[parseInt(m.month.slice(5, 7), 10) - 1] + " '" + m.month.slice(2, 4);
                    return (
                      <div key={m.month} className="flex-1 flex flex-col items-center justify-end gap-0.5">
                        <div className="w-full flex items-end justify-center gap-0.5" style={{ height: 72 }}>
                          <div
                            className="flex-1 rounded-sm bg-emerald-400/35 hover:bg-emerald-400/55 transition-colors"
                            style={{ height: incH }}
                            title={`Ingresos: ${fmt(m.income)}`}
                          />
                          <div
                            className="flex-1 rounded-sm bg-red-400/35 hover:bg-red-400/55 transition-colors"
                            style={{ height: spH }}
                            title={`Egresos: ${fmt(m.spend)}`}
                          />
                        </div>
                        <span className="text-[9px] text-white/20 mt-1.5 whitespace-nowrap">{label}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-4 mt-4">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-sm bg-emerald-400/50" />
                    <span className="text-[10px] text-white/25">Ingresos</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-sm bg-red-400/50" />
                    <span className="text-[10px] text-white/25">Egresos</span>
                  </div>
                </div>
              </div>
            )}

            {/* Top categories */}
            {summary.categoryBreakdown.length > 0 && (
              <div className="p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
                <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-5">Gastos este mes</p>
                <div className="space-y-3">
                  {summary.categoryBreakdown.map((c) => (
                    <div key={c.category} className="flex items-center gap-3">
                      <span className="text-sm text-white/50 w-28 shrink-0 truncate">
                        {CATEGORY_NAMES[c.category] ?? c.category}
                      </span>
                      <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#0ea5e9]/40 rounded-full"
                          style={{ width: `${(c.amount / maxCategory) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-white/35 w-24 text-right shrink-0">
                        {fmt(c.amount)}
                      </span>
                    </div>
                  ))}
                </div>
                <Link href="/analytics" className="mt-4 block text-xs text-[#0ea5e9]/60 hover:text-[#0ea5e9] transition-colors text-right">
                  Ver analítica completa →
                </Link>
              </div>
            )}
          </div>
        )}

        {/* ── Coach recommendations ── */}
        {coach.length > 0 && (
          <div className="p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs text-white/25 uppercase tracking-[0.15em]">Coach</p>
                <p className="text-xs text-white/20 mt-0.5">Recomendaciones del mes</p>
              </div>
            </div>
            <div className="space-y-3">
              {coach.slice(0, 2).map((rec) => (
                <div key={rec.id} className="flex gap-3 p-3 rounded-xl bg-white/[0.03] border border-white/[0.05]">
                  <div className="w-7 h-7 rounded-lg bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-[#0ea5e9] text-sm">→</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white/80 leading-snug">{rec.title}</p>
                    <p className="text-xs text-white/35 mt-0.5 leading-snug">{rec.action}</p>
                  </div>
                  {rec.estimatedImpactClp > 0 && (
                    <div className="shrink-0 text-right">
                      <p className="text-[10px] text-white/25">ahorro est.</p>
                      <p className="text-xs font-mono text-emerald-400/70">
                        {new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(rec.estimatedImpactClp)}
                      </p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Connected Banks ── */}
        <section>
          {!loading && connected.length === 0 && available.length === 0 && (
            <div className="text-center py-20">
              <p className="text-white/20 text-sm">No hay bancos disponibles.</p>
            </div>
          )}

          {/* Skeleton cards */}
          {loading && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="p-5 rounded-2xl border border-white/[0.08] bg-white/[0.03] animate-pulse">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-9 h-9 rounded-xl bg-white/[0.07]" />
                    <div className="flex-1">
                      <div className="h-3 w-20 bg-white/[0.07] rounded-full mb-2" />
                      <div className="h-2.5 w-14 bg-white/[0.04] rounded-full" />
                    </div>
                  </div>
                  <div className="h-7 w-32 bg-white/[0.07] rounded-lg mb-4" />
                  <div className="h-8 w-full bg-white/[0.04] rounded-xl" />
                </div>
              ))}
            </div>
          )}

          {connected.length > 0 && (
            <>
              <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-4">Mis cuentas</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-10">
                {connected.map((b) => (
                  <div key={b.id} className="group p-5 rounded-2xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.05] transition-all flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 flex items-center justify-center text-sm font-bold text-[#0ea5e9]">
                          {b.name[0]}
                        </div>
                        <div>
                          <p className="text-sm font-semibold">{b.name}</p>
                          <p className="text-xs text-white/25">{b.lastSyncedAt ? fmtDate(b.lastSyncedAt) : "Sin sincronizar"}</p>
                        </div>
                      </div>
                      <div className="w-2 h-2 rounded-full bg-emerald-500/80" title="Conectado" />
                    </div>

                    {b.balance !== null && (
                      <p className="text-2xl font-mono font-bold tracking-tight">{fmt(b.balance)}</p>
                    )}

                    <div className="flex gap-2 mt-auto">
                      <button
                        onClick={() => setScraping({ id: b.id, name: b.name })}
                        className="flex-1 py-2 rounded-xl bg-[#0ea5e9] text-black text-xs font-bold hover:bg-[#38bdf8] transition-colors"
                      >
                        Sincronizar
                      </button>
                      <Link
                        href={`/movements?bankId=${b.id}`}
                        className="px-3 py-2 rounded-xl border border-white/[0.08] text-xs text-white/40 hover:text-white hover:border-white/20 transition-colors"
                      >
                        Ver
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ── Available Banks ── */}
          {!loading && available.length > 0 && (
            <>
              <p className="text-xs text-white/20 uppercase tracking-[0.15em] mb-3">Bancos disponibles</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                {available.map((b) => (
                  <Link
                    key={b.id}
                    href={`/banks?add=${b.id}`}
                    className="group flex items-center gap-2.5 px-3 py-3 rounded-xl border border-white/[0.05] hover:border-[#0ea5e9]/30 bg-white/[0.02] hover:bg-[#0ea5e9]/[0.05] transition-all"
                  >
                    <div className="w-7 h-7 rounded-lg bg-white/[0.05] flex items-center justify-center text-xs font-bold text-white/20 group-hover:text-white/50 transition-colors shrink-0">
                      {b.name[0]}
                    </div>
                    <p className="text-xs text-white/25 group-hover:text-white/60 transition-colors truncate">{b.name}</p>
                  </Link>
                ))}
              </div>
            </>
          )}

          {!loading && connected.length === 0 && available.length > 0 && (
            <p className="text-center text-white/20 text-xs mt-6">Conecta un banco para empezar a sincronizar.</p>
          )}
        </section>

        {/* ── Agentic Mode Settings ── */}
        {!loading && !gmailLoading && (
          <section className="flex items-center justify-between gap-4 px-4 py-3 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
            <div className="flex items-center gap-3 min-w-0">
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <button
                  type="button"
                  role="switch"
                  aria-checked={agenticMode}
                  onClick={() => toggleAgenticMode(!agenticMode)}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${agenticMode ? "bg-[#0ea5e9]" : "bg-white/10"}`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${agenticMode ? "translate-x-[18px]" : "translate-x-[3px]"}`}
                  />
                </button>
                <span className="text-sm text-white/60">Sincronización agéntica</span>
              </label>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {agenticMode && !gmailConnected && (
                <a
                  href="/api/gmail/connect"
                  className="px-3 py-1.5 rounded-lg border border-[#0ea5e9]/30 text-xs text-[#0ea5e9] hover:bg-[#0ea5e9]/10 transition-colors"
                >
                  Conecta Gmail
                </a>
              )}
              {agenticMode && gmailConnected && (
                <>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-xs text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    Gmail conectado
                  </span>
                  <button
                    onClick={disconnectGmail}
                    className="text-xs text-white/25 hover:text-white/50 transition-colors"
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
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-white/10 backdrop-blur-md border border-white/20 rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-2xl pointer-events-none">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          {toast}
        </div>
      )}
    </div>
  );
}
