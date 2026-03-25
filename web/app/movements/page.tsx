"use client";

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
  bchile: "Banco Chile",
  bci: "BCI",
  bestado: "BancoEstado",
  bice: "BICE",
  citi: "Citibank",
  edwards: "Edwards",
  falabella: "Falabella",
  itau: "Itaú",
  santander: "Santander",
  scotiabank: "Scotiabank",
};

export default function MovementsPage() {
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
  const total = movements.reduce((sum, m) => sum + parseFloat(m.amount), 0);

  return (
    <div className="min-h-screen">
      <nav className="border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-[#0ea5e9]" />
          <span className="font-bold text-sm tracking-tight">Open Banking Chile</span>
        </Link>
        <Link href="/banks" className="text-sm text-white/50 hover:text-white transition-colors">
          Cuentas
        </Link>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="mb-6 flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
          <div>
            <Link href="/dashboard" className="text-xs text-white/30 hover:text-white/60 mb-2 block">← Volver</Link>
            <h1 className="text-2xl font-bold">Movimientos</h1>
            <p className="text-white/40 text-sm mt-1">{movements.length} registros</p>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2">
            <select
              value={bankFilter}
              onChange={(e) => setBankFilter(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-[#0ea5e9]/50"
            >
              <option value="">Todos los bancos</option>
              {banks.map((b) => (
                <option key={b} value={b}>{BANK_NAMES[b] ?? b}</option>
              ))}
            </select>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-[#0ea5e9]/50"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white/70 focus:outline-none focus:border-[#0ea5e9]/50"
            />
          </div>
        </div>

        {/* Summary */}
        {movements.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
            <StatCard label="Total movimientos" value={movements.length.toString()} />
            <StatCard
              label="Egresos"
              value={fmt(movements.filter((m) => parseFloat(m.amount) < 0).reduce((s, m) => s + parseFloat(m.amount), 0))}
              color="text-red-400"
            />
            <StatCard
              label="Ingresos"
              value={fmt(movements.filter((m) => parseFloat(m.amount) > 0).reduce((s, m) => s + parseFloat(m.amount), 0))}
              color="text-green-400"
            />
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="text-center py-20 text-white/30 text-sm">Cargando…</div>
        ) : movements.length === 0 ? (
          <div className="text-center py-20 text-white/30 text-sm">
            No hay movimientos.{" "}
            <Link href="/dashboard" className="text-[#0ea5e9] hover:underline">
              Sincroniza un banco.
            </Link>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/8 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5 text-white/30 text-xs uppercase tracking-wider">
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
                  const isNeg = amount < 0;
                  return (
                    <tr key={m.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3 text-white/50 whitespace-nowrap">{m.date}</td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <span className="text-xs bg-white/5 px-2 py-0.5 rounded-full text-white/40">
                          {BANK_NAMES[m.bankId] ?? m.bankId}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-white/80 max-w-xs truncate">{m.description}</td>
                      <td className={`px-4 py-3 text-right font-mono font-medium whitespace-nowrap ${isNeg ? "text-red-400" : "text-green-400"}`}>
                        {fmt(amount)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-white/30 text-xs whitespace-nowrap hidden md:table-cell">
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

function StatCard({ label, value, color = "text-white" }: { label: string; value: string; color?: string }) {
  return (
    <div className="p-4 rounded-2xl border border-white/8 bg-white/[0.02]">
      <p className="text-xs text-white/30 mb-1">{label}</p>
      <p className={`text-lg font-bold font-mono ${color}`}>{value}</p>
    </div>
  );
}

function fmt(n: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);
}
