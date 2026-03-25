"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import ScrapeProgress from "@/components/ScrapeProgress";

interface BankStatus {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  lastSyncedAt: string | null;
  isSyncing: boolean;
}

export default function DashboardPage() {
  const [banks, setBanks] = useState<BankStatus[]>([]);
  const [scraping, setScraping] = useState<{ id: string; name: string } | null>(null);

  async function loadBanks() {
    const res = await fetch("/api/banks");
    if (res.ok) setBanks(await res.json());
  }

  useEffect(() => { loadBanks(); }, []);

  function handleSyncDone() {
    setScraping(null);
    loadBanks();
  }

  function handleSyncError() {
    setScraping(null);
    loadBanks();
  }

  const connected = banks.filter((b) => b.connected);
  const notConnected = banks.filter((b) => !b.connected);

  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav className="border-b border-white/5 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-[#0ea5e9]" />
          <span className="font-bold text-sm tracking-tight">Open Banking Chile</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/movements" className="text-sm text-white/50 hover:text-white transition-colors">
            Movimientos
          </Link>
          <Link href="/banks" className="text-sm text-white/50 hover:text-white transition-colors">
            Cuentas
          </Link>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="text-sm text-white/30 hover:text-white/60 transition-colors"
          >
            Salir
          </button>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Mis bancos</h1>
          <p className="text-white/40 text-sm mt-1">
            {connected.length} {connected.length === 1 ? "banco conectado" : "bancos conectados"}
          </p>
        </div>

        {/* Connected banks */}
        {connected.length > 0 && (
          <section className="mb-10">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {connected.map((bank) => (
                <BankCard
                  key={bank.id}
                  bank={bank}
                  onSync={() => setScraping({ id: bank.id, name: bank.name })}
                />
              ))}
            </div>
          </section>
        )}

        {/* Not connected */}
        {notConnected.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-white/30 uppercase tracking-widest mb-3">
              Bancos disponibles
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {notConnected.map((bank) => (
                <Link
                  key={bank.id}
                  href={`/banks?add=${bank.id}`}
                  className="p-4 rounded-2xl border border-white/5 hover:border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-all flex items-center gap-3"
                >
                  <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center text-sm font-bold text-white/30">
                    {bank.name[0]}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white/40">{bank.name}</p>
                    <p className="text-xs text-white/20">Conectar →</p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Scrape overlay */}
      {scraping && (
        <ScrapeProgress
          bankId={scraping.id}
          bankName={scraping.name}
          onDone={handleSyncDone}
          onError={handleSyncError}
        />
      )}
    </div>
  );
}

function BankCard({ bank, onSync }: { bank: BankStatus; onSync: () => void }) {
  const lastSync = bank.lastSyncedAt
    ? new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(bank.lastSyncedAt))
    : null;

  return (
    <div className="p-4 rounded-2xl border border-white/8 bg-white/[0.03] flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 flex items-center justify-center text-sm font-bold text-[#0ea5e9]">
          {bank.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{bank.name}</p>
          <p className="text-xs text-white/30">{lastSync ? `Última sync: ${lastSync}` : "Sin sincronizar"}</p>
        </div>
      </div>

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
          className="px-3 py-2 rounded-xl border border-white/8 text-xs text-white/50 hover:text-white hover:border-white/20 transition-colors"
        >
          Ver
        </Link>
      </div>
    </div>
  );
}
