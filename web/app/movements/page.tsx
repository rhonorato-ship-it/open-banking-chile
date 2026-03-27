"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

interface Movement {
  id: string;
  bankId: string;
  date: string;
  description: string;
  amount: string;
  balance: string | null;
  source: string | null;
}

const BANK_NAMES: Record<string, string> = {
  bchile: "Banco Chile", bci: "BCI", bestado: "BancoEstado", bice: "BICE",
  citi: "Citibank", edwards: "Edwards", falabella: "Falabella",
  itau: "Itaú", santander: "Santander", scotiabank: "Scotiabank",
};

const MONTHS_ES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const PAGE_SIZE = 50;

type SortField = "date" | "amount";
type SortDir = "asc" | "desc";

export default function MovementsPage() {
  return <Suspense><MovementsPageContent /></Suspense>;
}

function MovementsPageContent() {
  const searchParams = useSearchParams();
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);
  const [bankFilter, setBankFilter] = useState(searchParams.get("bankId") ?? "");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);
  const [driveState, setDriveState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [driveUrl, setDriveUrl] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (bankFilter) params.set("bankId", bankFilter);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const res = await fetch(`/api/movements?${params}`);
    if (res.ok) setMovements(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, [bankFilter, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPage(0); }, [bankFilter, from, to, search, sortField, sortDir]);

  const banks = useMemo(() => [...new Set(movements.map((m) => m.bankId))], [movements]);

  const filtered = useMemo(() => {
    let rows = movements;
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((m) => m.description.toLowerCase().includes(q));
    }
    return [...rows].sort((a, b) => {
      const cmp = sortField === "date"
        ? a.date.localeCompare(b.date)
        : parseFloat(a.amount) - parseFloat(b.amount);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [movements, search, sortField, sortDir]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const income = filtered.filter((m) => parseFloat(m.amount) > 0).reduce((s, m) => s + parseFloat(m.amount), 0);
  const expenses = filtered.filter((m) => parseFloat(m.amount) < 0).reduce((s, m) => s + parseFloat(m.amount), 0);

  // Monthly data for chart — always derived from full (unfiltered) movements
  const monthlyData = useMemo(() => {
    const map: Record<string, { income: number; expenses: number }> = {};
    for (const m of movements) {
      const month = m.date.slice(0, 7);
      if (!map[month]) map[month] = { income: 0, expenses: 0 };
      const amt = parseFloat(m.amount);
      if (amt > 0) map[month].income += amt;
      else map[month].expenses += Math.abs(amt);
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6);
  }, [movements]);

  async function exportToDrive() {
    setDriveState("loading");
    setDriveUrl(null);
    try {
      const res = await fetch("/api/drive", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setDriveUrl(data.url);
      setDriveState("done");
    } catch {
      setDriveState("error");
    }
  }

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("desc"); }
  }

  const SortIndicator = ({ field }: { field: SortField }) =>
    sortField === field ? <span className="ml-1 text-[#0ea5e9]">{sortDir === "desc" ? "↓" : "↑"}</span> : null;

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <nav className="border-b border-white/[0.06] px-6 h-14 flex items-center justify-between sticky top-0 bg-[#08080f]/90 backdrop-blur-sm z-10">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-5 h-5 rounded-full bg-[#0ea5e9]" />
          <span className="font-semibold text-sm tracking-tight">Open Banking Chile</span>
        </Link>
        <div className="flex items-center gap-5">
          <Link href="/analytics" className="text-sm text-white/40 hover:text-white/80 transition-colors">Analítica</Link>
          <Link href="/banks" className="text-sm text-white/40 hover:text-white/80 transition-colors">Cuentas</Link>
          <Link href="/dashboard" className="text-sm text-white/40 hover:text-white/80 transition-colors">Dashboard</Link>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-10">
        {/* Header + filters */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
          <div>
            <Link href="/dashboard" className="text-xs text-white/25 hover:text-white/60 mb-2 block transition-colors">← Volver</Link>
            <h1 className="text-2xl font-bold">Movimientos</h1>
            <p className="text-white/30 text-sm mt-1">
              {loading ? "Cargando…" : search ? `${filtered.length} de ${movements.length} registros` : `${movements.length} registros`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              placeholder="Buscar descripción…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/80 placeholder-white/20 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors w-44"
            />
            <select
              value={bankFilter}
              onChange={(e) => setBankFilter(e.target.value)}
              className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/60 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors"
            >
              <option value="">Todos los bancos</option>
              {banks.map((b) => <option key={b} value={b}>{BANK_NAMES[b] ?? b}</option>)}
            </select>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/60 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/60 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors" />
            {driveState === "done" && driveUrl ? (
              <a href={driveUrl} target="_blank" rel="noopener noreferrer"
                className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-3 py-2 text-sm text-emerald-400 hover:bg-emerald-500/20 transition-colors whitespace-nowrap">
                Ver archivo ↗
              </a>
            ) : (
              <button onClick={exportToDrive} disabled={driveState === "loading"}
                className="bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white/60 hover:text-white/80 hover:bg-white/[0.07] transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                {driveState === "loading" ? "Exportando…" : driveState === "error" ? "Error — reintentar" : "Exportar a Drive"}
              </button>
            )}
          </div>
        </div>

        {/* Summary cards */}
        {loading ? (
          <div className="grid grid-cols-3 gap-3 mb-8 animate-pulse">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
                <div className="h-2.5 w-16 bg-white/[0.06] rounded-full mb-3" />
                <div className="h-6 w-24 bg-white/[0.06] rounded-lg" />
              </div>
            ))}
          </div>
        ) : movements.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-8">
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Movimientos</p>
              <p className="text-xl font-bold font-mono">{filtered.length}</p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Egresos</p>
              <p className="text-xl font-bold font-mono text-red-400">{fmt(expenses)}</p>
            </div>
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Ingresos</p>
              <p className="text-xl font-bold font-mono text-emerald-400">{fmt(income)}</p>
            </div>
          </div>
        )}

        {/* Monthly chart */}
        {!loading && monthlyData.length >= 2 && (
          <div className="mb-8 p-5 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
            <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-5">Últimos 6 meses</p>
            <MonthlyChart data={monthlyData} />
          </div>
        )}

        {/* Table skeleton */}
        {loading && (
          <div className="rounded-2xl border border-white/[0.07] overflow-hidden animate-pulse">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="flex gap-4 px-4 py-3.5 border-b border-white/[0.03]">
                <div className="h-3 w-16 bg-white/[0.06] rounded-full" />
                <div className="h-3 w-14 bg-white/[0.04] rounded-full hidden sm:block" />
                <div className="h-3 flex-1 bg-white/[0.06] rounded-full" />
                <div className="h-3 w-20 bg-white/[0.06] rounded-full ml-auto" />
              </div>
            ))}
          </div>
        )}

        {/* Empty states */}
        {!loading && movements.length === 0 && (
          <div className="text-center py-20">
            <p className="text-white/20 text-sm">No hay movimientos.</p>
            <Link href="/dashboard" className="text-[#0ea5e9] text-sm hover:underline mt-2 inline-block">
              Sincroniza un banco.
            </Link>
          </div>
        )}

        {!loading && movements.length > 0 && filtered.length === 0 && (
          <div className="text-center py-16">
            <p className="text-white/20 text-sm">Sin resultados para &ldquo;{search}&rdquo;</p>
            <button onClick={() => setSearch("")} className="text-[#0ea5e9] text-sm hover:underline mt-2 block mx-auto">
              Limpiar búsqueda
            </button>
          </div>
        )}

        {/* Table */}
        {!loading && filtered.length > 0 && (
          <>
            <div className="rounded-2xl border border-white/[0.07] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.05] text-white/25 text-xs uppercase tracking-wider">
                    <th
                      className="text-left px-4 py-3 font-medium cursor-pointer hover:text-white/50 transition-colors select-none"
                      onClick={() => toggleSort("date")}
                    >
                      Fecha<SortIndicator field="date" />
                    </th>
                    <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Banco</th>
                    <th className="text-left px-4 py-3 font-medium">Descripción</th>
                    <th
                      className="text-right px-4 py-3 font-medium cursor-pointer hover:text-white/50 transition-colors select-none"
                      onClick={() => toggleSort("amount")}
                    >
                      Monto<SortIndicator field="amount" />
                    </th>
                    <th className="text-right px-4 py-3 font-medium hidden md:table-cell">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((m) => {
                    const amount = parseFloat(m.amount);
                    return (
                      <tr key={m.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-3 text-white/40 whitespace-nowrap text-xs">{m.date}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <span className="text-[11px] bg-white/[0.05] px-2 py-0.5 rounded-full text-white/35">
                            {BANK_NAMES[m.bankId] ?? m.bankId}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-white/70 max-w-xs truncate">{m.description}</td>
                        <td className={`px-4 py-3 text-right font-mono font-semibold whitespace-nowrap text-sm ${amount < 0 ? "text-red-400" : "text-emerald-400"}`}>
                          {fmt(amount)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white/25 text-xs whitespace-nowrap hidden md:table-cell">
                          {m.balance ? fmt(parseFloat(m.balance)) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 px-1">
                <p className="text-xs text-white/25">
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} de {filtered.length}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="px-3 py-1.5 rounded-lg border border-white/[0.07] text-xs text-white/40 hover:text-white hover:border-white/20 disabled:opacity-30 transition-colors"
                  >
                    ← Anterior
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page === totalPages - 1}
                    className="px-3 py-1.5 rounded-lg border border-white/[0.07] text-xs text-white/40 hover:text-white hover:border-white/20 disabled:opacity-30 transition-colors"
                  >
                    Siguiente →
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ── Monthly chart (CSS bars, no dependencies) ──────────────────

function MonthlyChart({ data }: { data: [string, { income: number; expenses: number }][] }) {
  const maxVal = Math.max(...data.flatMap(([, v]) => [v.income, v.expenses]), 1);

  return (
    <div>
      <div className="flex items-end gap-3" style={{ height: 80 }}>
        {data.map(([month, v]) => {
          const incomeH = Math.max(3, (v.income / maxVal) * 80);
          const expH = Math.max(3, (v.expenses / maxVal) * 80);
          const label = MONTHS_ES[parseInt(month.slice(5, 7), 10) - 1] + " '" + month.slice(2, 4);

          return (
            <div key={month} className="flex-1 flex flex-col items-center justify-end gap-0.5">
              <div className="w-full flex items-end justify-center gap-0.5" style={{ height: 80 }}>
                <div
                  className="flex-1 rounded-sm bg-emerald-400/35 hover:bg-emerald-400/55 transition-colors cursor-default"
                  style={{ height: incomeH }}
                  title={`Ingresos: ${fmt(v.income)}`}
                />
                <div
                  className="flex-1 rounded-sm bg-red-400/35 hover:bg-red-400/55 transition-colors cursor-default"
                  style={{ height: expH }}
                  title={`Egresos: ${fmt(v.expenses)}`}
                />
              </div>
              <span className="text-[9px] text-white/20 mt-2 whitespace-nowrap">{label}</span>
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
  );
}

function fmt(n: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);
}
