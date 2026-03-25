"use client";

import { Suspense } from "react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

interface BankStatus {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  lastSyncedAt: string | null;
}

export default function BanksPage() {
  return <Suspense><BanksPageContent /></Suspense>;
}

function BanksPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselect = searchParams.get("add");

  const [banks, setBanks] = useState<BankStatus[]>([]);
  const [editing, setEditing] = useState<string | null>(preselect);
  const [rut, setRut] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function loadBanks() {
    const res = await fetch("/api/banks");
    if (res.ok) setBanks(await res.json());
  }

  useEffect(() => { loadBanks(); }, []);

  async function save(bankId: string) {
    if (!rut || !password) { setError("Completa RUT y contraseña"); return; }
    setSaving(true);
    setError("");
    const res = await fetch("/api/banks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankId, rut, password }),
    });
    setSaving(false);
    if (res.ok) {
      setEditing(null);
      setRut("");
      setPassword("");
      await loadBanks();
      if (preselect) router.push("/dashboard");
    } else {
      setError("Error al guardar — intenta de nuevo");
    }
  }

  async function remove(bankId: string) {
    setDeleting(bankId);
    await fetch("/api/banks", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankId }),
    });
    setDeleting(null);
    await loadBanks();
  }

  return (
    <div className="min-h-screen bg-[#05050a] text-white">
      <nav className="border-b border-white/[0.06] px-6 py-4 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full bg-[#0ea5e9]" />
          <span className="font-bold text-sm tracking-tight">Open Banking Chile</span>
        </Link>
        <div className="flex items-center gap-6">
          <Link href="/movements" className="text-sm text-white/40 hover:text-white transition-colors">Movimientos</Link>
          <Link href="/dashboard" className="text-sm text-white/40 hover:text-white transition-colors">Dashboard</Link>
        </div>
      </nav>

      <main className="max-w-xl mx-auto px-6 py-10">
        <div className="mb-8">
          <Link href="/dashboard" className="text-xs text-white/30 hover:text-white/60 mb-3 block">← Volver</Link>
          <h1 className="text-2xl font-bold">Cuentas bancarias</h1>
          <p className="text-white/40 text-sm mt-1">Las credenciales se guardan encriptadas con AES-256.</p>
        </div>

        <div className="flex flex-col gap-3">
          {banks.map((bank) => (
            <div key={bank.id} className="rounded-2xl border border-white/8 bg-white/[0.03] overflow-hidden">
              {/* Bank row */}
              <div className="px-4 py-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center text-xs font-bold text-white/50">
                  {bank.name[0]}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold">{bank.name}</p>
                  <p className="text-xs text-white/30">{bank.connected ? "Conectado" : "Sin conectar"}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setEditing(editing === bank.id ? null : bank.id);
                      setRut("");
                      setPassword("");
                      setError("");
                    }}
                    className="text-xs px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 text-white/60 hover:text-white transition-colors"
                  >
                    {bank.connected ? "Editar" : "Conectar"}
                  </button>
                  {bank.connected && (
                    <button
                      onClick={() => remove(bank.id)}
                      disabled={deleting === bank.id}
                      className="text-xs px-3 py-1.5 rounded-lg border border-red-500/20 text-red-400/60 hover:text-red-400 hover:border-red-500/40 transition-colors disabled:opacity-40"
                    >
                      {deleting === bank.id ? "…" : "Eliminar"}
                    </button>
                  )}
                </div>
              </div>

              {/* Inline form */}
              {editing === bank.id && (
                <div className="border-t border-white/5 px-4 py-4 flex flex-col gap-3">
                  <input
                    type="text"
                    placeholder="RUT (ej: 12345678-9)"
                    value={rut}
                    onChange={(e) => setRut(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-[#0ea5e9]/50"
                  />
                  <input
                    type="password"
                    placeholder="Contraseña"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && save(bank.id)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-[#0ea5e9]/50"
                  />
                  {error && <p className="text-xs text-red-400">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => save(bank.id)}
                      disabled={saving}
                      className="flex-1 py-2 rounded-xl bg-[#0ea5e9] text-black text-xs font-bold hover:bg-[#38bdf8] disabled:opacity-40 transition-colors"
                    >
                      {saving ? "Guardando…" : "Guardar"}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="px-4 py-2 rounded-xl border border-white/8 text-xs text-white/40 hover:text-white transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
