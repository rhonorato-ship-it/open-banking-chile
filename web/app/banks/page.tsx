"use client";

import { Suspense, useEffect, useState } from "react";
import { isValidRut, normalizeRut } from "@/lib/rut";
import { useRouter, useSearchParams } from "next/navigation";
import Navigation from "@/components/Navigation";

const EMAIL_BANKS = new Set(["fintual", "racional"]);
const IDENTIFIER_BANKS = new Set(["mercadopago"]);
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
    <div className="min-h-screen">
      <Navigation />

      <main className="max-w-2xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Cuentas bancarias</h1>
          <p className="text-slate-400 text-sm mt-1">Credenciales encriptadas con AES-256.</p>
        </div>

        {connected.length > 0 && (
          <div className="mb-8">
            <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">Conectadas</p>
            <div className="flex flex-col gap-2">
              {connected.map((bank) => (
                <BankRow key={bank.id} bank={bank} autoOpen={false} onSave={save} onRemove={remove} />
              ))}
            </div>
          </div>
        )}

        {available.length > 0 && (
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">Disponibles</p>
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
  const theme = BANK_THEME[bank.id] ?? DEFAULT_THEME;

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
    <div className={`rounded-2xl border overflow-hidden transition-colors ${bank.connected ? `border-2 ${theme.border} ${theme.bg}` : "border border-slate-200 bg-white"}`}>
      <div className="px-4 py-3.5 flex items-center gap-3">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold shrink-0 ${bank.connected ? `${theme.accent} text-white` : `${theme.bg} border ${theme.border} ${theme.text}`}`}>
          {bank.name[0]}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${bank.connected ? "text-slate-900" : "text-slate-400"}`}>{bank.name}</p>
          {bank.connected && bank.lastSyncedAt && (
            <p className="text-xs text-slate-400">
              {new Intl.DateTimeFormat("es-CL", { dateStyle: "short" }).format(new Date(bank.lastSyncedAt))}
            </p>
          )}
        </div>
        {bank.connected && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />}

        {confirmDelete ? (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-slate-400">¿Eliminar?</span>
            <button
              onClick={handleRemove}
              disabled={deleting}
              className="text-xs px-3 py-1.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-600 hover:bg-rose-100 transition-colors disabled:opacity-40"
            >
              {deleting ? "…" : "Sí"}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-400 hover:text-slate-700 transition-colors"
            >
              No
            </button>
          </div>
        ) : (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => { setOpen(!open); setRut(""); setPassword(""); setError(""); }}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${bank.connected ? "border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700" : "border-teal-200 text-teal-600 hover:border-teal-400 hover:bg-teal-50"}`}
            >
              {bank.connected ? "Editar" : "Conectar"}
            </button>
            {bank.connected && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-xs px-3 py-1.5 rounded-lg border border-rose-100 text-rose-400 hover:text-rose-600 hover:border-rose-200 transition-colors"
              >
                Eliminar
              </button>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="border-t border-slate-200 px-4 py-4 flex flex-col gap-3 bg-white/80">
          <div>
            <input
              type={EMAIL_BANKS.has(bank.id) ? "email" : "text"}
              placeholder={rutFieldPlaceholder(bank.id)}
              value={rut}
              onChange={(e) => { setRut(e.target.value); setError(""); }}
              className={`w-full bg-white border rounded-xl px-3 py-2.5 text-sm placeholder-slate-300 focus:outline-none transition-colors ${
                validateRut && rut && !isValidRut(rut)
                  ? "border-rose-300 focus:border-rose-400"
                  : validateRut && rut && isValidRut(rut)
                  ? "border-emerald-300 focus:border-emerald-400"
                  : "border-slate-200 focus:border-teal-400"
              }`}
            />
            {validateRut && rut && isValidRut(rut) && (
              <p className="text-[11px] text-emerald-600 mt-1 px-1">{normalizeRut(rut)}</p>
            )}
            {validateRut && rut && !isValidRut(rut) && (
              <p className="text-[11px] text-rose-500 mt-1 px-1">Formato: 12345678-9 o 12.345.678-9</p>
            )}
          </div>
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
            className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm placeholder-slate-300 focus:outline-none focus:border-teal-400 transition-colors"
          />
          {error && <p className="text-xs text-rose-500">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2 rounded-xl bg-teal-600 text-white text-xs font-bold hover:bg-teal-700 disabled:opacity-40 transition-colors"
            >
              {saving ? "Guardando…" : "Guardar"}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="px-4 py-2 rounded-xl border border-slate-200 text-xs text-slate-400 hover:text-slate-700 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
