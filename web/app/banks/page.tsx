"use client";

import { Suspense, useEffect, useState } from "react";
import { isValidRut, normalizeRut } from "@/lib/rut";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

// Banks where the "rut" field is an email address
const EMAIL_BANKS = new Set(["fintual", "racional"]);
// Banks where the "rut" field is an open identifier (email / RUT / phone)
const IDENTIFIER_BANKS = new Set(["mercadopago"]);
// Banks where the "rut" field is an alphanumeric username (not a Chilean RUT)
const USERNAME_BANKS = new Set(["citi"]);

function rutFieldLabel(bankId: string): string {
  if (EMAIL_BANKS.has(bankId)) return "Email";
  if (IDENTIFIER_BANKS.has(bankId)) return "Email / RUT / Teléfono";
  if (USERNAME_BANKS.has(bankId)) return "Usuario";
  return "RUT";
}

function rutFieldPlaceholder(bankId: string): string {
  if (EMAIL_BANKS.has(bankId)) return "tu@email.com";
  if (IDENTIFIER_BANKS.has(bankId)) return "Email, RUT o teléfono";
  if (USERNAME_BANKS.has(bankId)) return "Nombre de usuario";
  return "RUT (ej: 12345678-9)";
}

function useRutValidation(bankId: string): boolean {
  return !EMAIL_BANKS.has(bankId) && !IDENTIFIER_BANKS.has(bankId) && !USERNAME_BANKS.has(bankId);
}

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

  async function loadBanks() {
    const res = await fetch("/api/banks");
    if (res.ok) setBanks(await res.json());
  }

  useEffect(() => { loadBanks(); }, []);

  async function save(bankId: string, rut: string, password: string): Promise<boolean> {
    const res = await fetch("/api/banks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankId, rut, password }),
    });
    if (res.ok) {
      await loadBanks();
      if (preselect) router.push("/dashboard");
      return true;
    }
    return false;
  }

  async function remove(bankId: string) {
    await fetch("/api/banks", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankId }),
    });
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
          <Link href="/analytics" className="text-sm text-white/40 hover:text-white/80 transition-colors">Analítica</Link>
          <Link href="/dashboard" className="text-sm text-white/40 hover:text-white/80 transition-colors">Dashboard</Link>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-10">
        <div className="mb-8">
          <Link href="/dashboard" className="text-xs text-white/25 hover:text-white/60 mb-3 block transition-colors">← Volver</Link>
          <h1 className="text-2xl font-bold">Cuentas bancarias</h1>
          <p className="text-white/35 text-sm mt-1">Credenciales encriptadas con AES-256.</p>
        </div>

        {connected.length > 0 && (
          <div className="mb-8">
            <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-3">Conectadas</p>
            <div className="flex flex-col gap-2">
              {connected.map((bank) => (
                <BankRow key={bank.id} bank={bank} autoOpen={false} onSave={save} onRemove={remove} />
              ))}
            </div>
          </div>
        )}

        {available.length > 0 && (
          <div>
            <p className="text-xs text-white/25 uppercase tracking-[0.15em] mb-3">Disponibles</p>
            <div className="flex flex-col gap-2">
              {available.map((bank) => (
                <BankRow key={bank.id} bank={bank} autoOpen={bank.id === preselect} onSave={save} onRemove={remove} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function BankRow({
  bank, autoOpen, onSave, onRemove,
}: {
  bank: BankStatus;
  autoOpen: boolean;
  onSave: (bankId: string, rut: string, password: string) => Promise<boolean>;
  onRemove: (bankId: string) => void;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [rut, setRut] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");

  const validateRut = useRutValidation(bank.id);
  const label = rutFieldLabel(bank.id);

  async function handleSave() {
    if (!rut || !password) { setError(`Completa ${label.toLowerCase()} y contraseña`); return; }
    if (validateRut && !isValidRut(rut)) { setError("RUT inválido — ej: 12345678-9"); return; }
    setSaving(true);
    setError("");
    const normalized = validateRut ? normalizeRut(rut)! : rut.trim();
    const ok = await onSave(bank.id, normalized, password);
    setSaving(false);
    if (ok) {
      setOpen(false);
      setRut("");
      setPassword("");
    } else {
      setError("Error al guardar — intenta de nuevo");
    }
  }

  async function handleRemove() {
    setDeleting(true);
    await onRemove(bank.id);
    setDeleting(false);
    setConfirmDelete(false);
  }

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

        {confirmDelete ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-white/40">¿Eliminar?</span>
            <button
              onClick={handleRemove}
              disabled={deleting}
              className="text-xs px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 transition-colors disabled:opacity-40"
            >
              {deleting ? "…" : "Sí"}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs px-3 py-1.5 rounded-lg border border-white/[0.08] text-white/40 hover:text-white transition-colors"
            >
              No
            </button>
          </div>
        ) : (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => { setOpen(!open); setRut(""); setPassword(""); setError(""); }}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${bank.connected ? "border-white/10 text-white/50 hover:border-white/25 hover:text-white" : "border-[#0ea5e9]/30 text-[#0ea5e9]/70 hover:border-[#0ea5e9]/60 hover:text-[#0ea5e9]"}`}
            >
              {bank.connected ? "Editar" : "Conectar"}
            </button>
            {bank.connected && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-xs px-3 py-1.5 rounded-lg border border-red-500/15 text-red-400/50 hover:text-red-400 hover:border-red-500/35 transition-colors"
              >
                Eliminar
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="border-t border-white/[0.05] px-4 py-4 flex flex-col gap-3">
          <div>
            <input
              type={EMAIL_BANKS.has(bank.id) ? "email" : "text"}
              placeholder={rutFieldPlaceholder(bank.id)}
              value={rut}
              onChange={(e) => { setRut(e.target.value); setError(""); }}
              className={`w-full bg-white/[0.04] border rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none transition-colors ${
                validateRut && rut && !isValidRut(rut)
                  ? "border-red-500/40 focus:border-red-500/60"
                  : validateRut && rut && isValidRut(rut)
                  ? "border-emerald-500/40 focus:border-emerald-500/60"
                  : "border-white/[0.08] focus:border-[#0ea5e9]/50"
              }`}
            />
            {validateRut && rut && isValidRut(rut) && (
              <p className="text-[11px] text-emerald-400/70 mt-1 px-1">{normalizeRut(rut)}</p>
            )}
            {validateRut && rut && !isValidRut(rut) && (
              <p className="text-[11px] text-red-400/70 mt-1 px-1">Formato: 12345678-9 o 12.345.678-9</p>
            )}
          </div>
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm placeholder-white/20 focus:outline-none focus:border-[#0ea5e9]/50 transition-colors"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2 rounded-xl bg-[#0ea5e9] text-black text-xs font-bold hover:bg-[#38bdf8] disabled:opacity-40 transition-colors"
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
            <button
              onClick={() => setOpen(false)}
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
