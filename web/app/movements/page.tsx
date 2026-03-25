"use client";

import { Suspense } from "react";
import { useEffect, useState } from "react";
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

  const banks = [...new Set(movements.map((m) => m.bankId))];
  const income = movements.filter((m) => parseFloat(m.amount) > 0).reduce((s, m) => s + parseFloat(m.amount), 0);
  const expenses = movements.filter((m) => parseFloat(m.amount) < 0).reduce((s, m) => s + parseFloat(m.amount), 0);

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <nav className="border-b border-white/[0.06] px-6 h-14 flex items-center justify-between sticky top-0 bg-[#08080f]/90 backdrop-blur-sm z-10">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-5 h-5 rounded-full bg-[#0ea5e9]" />
          <span className="font-semibold text-sm tracking-tight">Open Banking Chile</span>
        </Link>
        <div className="flex items-center gap-5">
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
            <p className="text-white/30 text-sm mt-1">{movements.length} registros</p>
          </div>
          <div className="flex flex-wrap gap-2">
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
          </div>
        </div>

        {/* Summary cards */}
        {movements.length > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-8">
            <div className="p-4 rounded-2xl border border-white/[0.07] bg-white/[0.03]">
              <p className="text-xs text-white/30 mb-1">Movimientos</p>
              <p className="text-xl font-bold font-mono">{movements.length}</p>
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

        {/* Table */}
        {loading ? (
          <div className="text-center py-20 text-white/20 text-sm">Cargando…</div>
        ) : movements.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-white/20 text-sm">No hay movimientos.</p>
            <Link href="/dashboard" className="text-[#0ea5e9] text-sm hover:underline mt-2 inline-block">
              Sincroniza un banco.
            </Link>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/[0.07] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.05] text-white/25 text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-3 font-medium">Fecha</th>
                  <th className="text-left px-4 py-3 font-medium hidden sm:table-cell">Banco</th>
                  <th className="text-left px-4 py-3 font-medium">Descripción</th>
                  <th className="text-right px-4 py-3 font-medium">Monto</th>
                  <th className="text-right px-4 py-3 font-medium hidden md:table-cell">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => {
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
        )}
      </main>
    </div>
  );
}

function fmt(n: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);
}
