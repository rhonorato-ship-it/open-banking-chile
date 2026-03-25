"use client";

import { Suspense } from "react";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

interface BankStatus {
  id: string;
  name: string;
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

  const connected = banks.filter((b) => b.connected);
  const available = banks.filter((b) => !b.connected);

  return (
    <div className="min-h-screen bg-[#08080f] text-white">
      <nav className="border-b border-white/[0.06] px-6 h-14 flex items-center justify-between sticky top-0 bg-[#08080f]/90 backdrop-blur-sm z-10">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-5 h-5 rounded-full bg-[#0ea5e9]" />
          <span className="font-semibold text-sm tracking-tight">Open Banking Chile</span>
        </Link>
        <div className="flex items-center gap-5">
          <Link href="/movements" className="text-sm text-white/40 hover:text-white/80 transition-colors">Movimientos</Link>
          <Link href="/dashboard" className="text-sm text-white/40 hover:text-white/80 transition-colors">Dashboard</Link>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-10">
        <div className="mb-8">
          <Link href="/dashboard" className="text-xs text-white/25 hover:text-white/60 mb-3 block transition-colors">← Volver</Link>
          <h1 className="text-2xl font-bold">Cuentas bancarias</h1>
          <p className="text-white/35 text-sm mt-1">Credenciales encriptadas con AES-256.</p>
        </div>

        {/* Connected */}
        {connected.length > 0 && (
          <div className="mb-8">
            <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-3">Conectadas</p>
            <div className="flex flex-col gap-2">
              {connected.map((bank) => (
                <BankRow
                  key={bank.id}
                  bank={bank}
                  editing={editing}
                  rut={rut}
                  password={password}
                  saving={saving}
                  deleting={deleting}
                  error={error}
                  setEditing={setEditing}
                  setRut={setRut}
                  setPassword={setPassword}
                  setError={setError}
                  onSave={save}
                  onRemove={remove}
                />
              ))}
            </div>
          </div>
        )}

        {/* Available */}
        {available.length > 0 && (
          <div>
            <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-3">Disponibles</p>
            <div className="flex flex-col gap-2">
              {available.map((bank) => (
                <BankRow
                  key={bank.id}
                  bank={bank}
                  editing={editing}
                  rut={rut}
                  password={password}
                  saving={saving}
                  deleting={deleting}
                  error={error}
                  setEditing={setEditing}
                  setRut={setRut}
                  setPassword={setPassword}
                  setError={setError}
                  onSave={save}
                  onRemove={remove}
                />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function BankRow({
  bank, editing, rut, password, saving, deleting, error,
  setEditing, setRut, setPassword, setError, onSave, onRemove,
}: {
  bank: BankStatus;
  editing: string | null;
  rut: string;
  password: string;
  saving: boolean;
  deleting: string | null;
  error: string;
  setEditing: (v: string | null) => void;
  setRut: (v: string) => void;
  setPassword: (v: string) => void;
  setError: (v: string) => void;
  onSave: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const isEditing = editing === bank.id;

  return (
    <div className={`rounded-2xl border overflow-hidden transition-colors ${bank.connected ? "border-white/[0.08] bg-white/[0.03]" : "border-white/[0.04] bg-white/[0.015]"}`}>
      <div className="px-4 py-3.5 flex items-center gap-3">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold shrink-0 ${bank.connected ? "bg-[#0ea5e9]/10 border border-[#0ea5e9]/20 text-[#0ea5e9]" : "bg-white/[0.05] text-white/25"}`}>
          {bank.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${bank.connected ? "text-white" : "text-white/40"}`}>{bank.name}</p>
          {bank.connected && bank.lastSyncedAt && (
            <p className="text-xs text-white/25">
              {new Intl.DateTimeFormat("es-CL", { dateStyle: "short" }).format(new Date(bank.lastSyncedAt))}
            </p>
          )}
        </div>
        {bank.connected && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/80 shrink-0" />}
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => {
              setEditing(isEditing ? null : bank.id);
              setRut(""); setPassword(""); setError("");
            }}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${bank.connected ? "border-white/10 text-white/50 hover:border-white/25 hover:text-white" : "border-[#0ea5e9]/30 text-[#0ea5e9]/70 hover:border-[#0ea5e9]/60 hover:text-[#0ea5e9]"}`}
          >
            {bank.connected ? "Editar" : "Conectar"}
          </button>
          {bank.connected && (
            <button
              onClick={() => onRemove(bank.id)}
              disabled={deleting === bank.id}
              className="text-xs px-3 py-1.5 rounded-lg border border-red-500/15 text-red-400/50 hover:text-red-400 hover:border-red-500/35 transition-colors disabled:opacity-40"
            >
              {deleting === bank.id ? "…" : "Eliminar"}
            </button>
          )}
        </div>
      </div>

      {isEditing && (
        <div className="border-t border-white/[0.05] px-4 py-4 flex flex-col gap-3">
          <input
            type="text"
            placeholder="RUT (ej: 12345678-9)"
            value={rut}
            onChange={(e) => setRut(e.target.value)}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors"
          />
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSave(bank.id)}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => onSave(bank.id)}
              disabled={saving}
              className="flex-1 py-2 rounded-xl bg-[#0ea5e9] text-black text-xs font-bold hover:bg-[#38bdf8] disabled:opacity-40 transition-colors"
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-4 py-2 rounded-xl border border-white/[0.07] text-xs text-white/35 hover:text-white transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
