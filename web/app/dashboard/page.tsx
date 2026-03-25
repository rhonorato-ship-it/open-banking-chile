"use client";

import { useEffect, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import Link from "next/link";
import ScrapeProgress from "@/components/ScrapeProgress";

interface BankStatus {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  lastSyncedAt: string | null;
  isSyncing: boolean;
  balance: number | null;
  change30d: number | null;
}

function fmt(n: number) {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [banks, setBanks] = useState<BankStatus[]>([]);
  const [scraping, setScraping] = useState<{ id: string; name: string } | null>(null);

  async function loadBanks() {
    const res = await fetch("/api/banks");
    if (res.ok) setBanks(await res.json());
  }

  useEffect(() => { loadBanks(); }, []);

  const connected = banks.filter((b) => b.connected);
  const available = banks.filter((b) => !b.connected);

  const totalBalance = connected.reduce((s, b) => s + (b.balance ?? 0), 0);
  const totalChange = connected.reduce((s, b) => s + (b.change30d ?? 0), 0);
  const hasBalance = connected.some((b) => b.balance !== null);

  const initial = session?.user?.name?.[0]?.toUpperCase() ?? session?.user?.email?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="min-h-screen bg-[#05050a] text-white">
      {/* Nav */}
      <nav className="border-b border-white/[0.06] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-[#0ea5e9]" />
          <span className="font-bold text-sm tracking-tight">Open Banking Chile</span>
        </div>
        <div className="flex items-center gap-6">
          <Link href="/movements" className="text-sm text-white/40 hover:text-white transition-colors">Movimientos</Link>
          <Link href="/banks" className="text-sm text-white/40 hover:text-white transition-colors">Cuentas</Link>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 transition-colors flex items-center justify-center text-xs font-bold text-white/70"
            title="Salir"
          >
            {initial}
          </button>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-12">

        {/* ── Tracker ── */}
        {connected.length > 0 && (
          <section className="mb-14">
            <p className="text-xs text-white/30 uppercase tracking-widest mb-3">Balance total</p>
            <div className="flex items-end gap-4 mb-2">
              <p className="text-5xl font-bold font-mono tracking-tight">
                {hasBalance ? fmt(totalBalance) : "—"}
              </p>
              {hasBalance && totalChange !== 0 && (
                <span className={`text-sm font-semibold mb-1.5 ${totalChange > 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {totalChange > 0 ? "↑" : "↓"} {fmt(Math.abs(totalChange))} este mes
                </span>
              )}
            </div>

            {/* Per-bank balance chips */}
            <div className="flex flex-wrap gap-2 mt-6">
              {connected.map((bank) => (
                <div key={bank.id} className="px-4 py-3 rounded-2xl bg-white/[0.04] border border-white/[0.07] flex flex-col gap-0.5 min-w-[130px]">
                  <p className="text-xs text-white/35">{bank.name}</p>
                  <p className="text-base font-mono font-semibold">
                    {bank.balance !== null ? fmt(bank.balance) : "—"}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Connections ── */}
        <section>
          {connected.length === 0 ? (
            <div className="text-center py-24">
              <p className="text-white/20 text-sm mb-4">No tienes bancos conectados aún.</p>
              <Link
                href="/banks"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#0ea5e9] text-black text-sm font-bold hover:bg-[#38bdf8] transition-colors"
              >
                Conectar banco →
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-10">
              {connected.map((bank) => (
                <ConnectedCard
                  key={bank.id}
                  bank={bank}
                  onSync={() => setScraping({ id: bank.id, name: bank.name })}
                />
              ))}
            </div>
          )}

          {available.length > 0 && (
            <>
              <p className="text-xs text-white/20 uppercase tracking-widest mb-3 mt-2">Bancos disponibles</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                {available.map((bank) => (
                  <Link
                    key={bank.id}
                    href={`/banks?add=${bank.id}`}
                    className="px-3 py-3 rounded-2xl border border-white/[0.05] hover:border-white/[0.12] bg-white/[0.02] hover:bg-white/[0.04] transition-all flex items-center gap-2.5 group"
                  >
                    <div className="w-7 h-7 rounded-lg bg-white/[0.05] flex items-center justify-center text-xs font-bold text-white/20 group-hover:text-white/40 transition-colors shrink-0">
                      {bank.name[0]}
                    </div>
                    <p className="text-xs font-medium text-white/25 group-hover:text-white/50 transition-colors truncate">{bank.name}</p>
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>
      </main>

      {scraping && (
        <ScrapeProgress
          bankId={scraping.id}
          bankName={scraping.name}
          onDone={() => { setScraping(null); loadBanks(); }}
          onError={() => { setScraping(null); loadBanks(); }}
        />
      )}
    </div>
  );
}

function ConnectedCard({ bank, onSync }: { bank: BankStatus; onSync: () => void }) {
  const lastSync = bank.lastSyncedAt
    ? new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(bank.lastSyncedAt))
    : null;

  return (
    <div className="p-4 rounded-2xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.05] transition-colors flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 flex items-center justify-center text-sm font-bold text-[#0ea5e9] shrink-0">
          {bank.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{bank.name}</p>
          <p className="text-xs text-white/25">{lastSync ? `Sync ${lastSync}` : "Sin sincronizar"}</p>
        </div>
      </div>

      {bank.balance !== null && (
        <p className="text-xl font-mono font-bold tracking-tight -mt-1">{fmt(bank.balance)}</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={onSync}
          disabled={bank.isSyncing}
          className="flex-1 py-2 rounded-xl bg-[#0ea5e9] text-black text-xs font-bold hover:bg-[#38bdf8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {bank.isSyncing ? "Sincronizando…" : "Sincronizar"}
        </button>
        <Link
          href={`/movements?bankId=${bank.id}`}
          className="px-3 py-2 rounded-xl border border-white/[0.08] text-xs text-white/40 hover:text-white hover:border-white/20 transition-colors"
        >
          Ver
        </Link>
      </div>
    </div>
  );
}
