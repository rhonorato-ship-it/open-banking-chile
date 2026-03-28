"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";

type Phase = 1 | 2 | 3 | 4 | 5;

interface PhaseEvent {
  phase: Phase;
  label?: string;
  message?: string;
  done?: boolean;
  error?: boolean;
  requires_2fa?: boolean;
  agentic?: boolean;
}

interface Props {
  bankId: string;
  bankName: string;
  agentic?: boolean;
  onDone: () => void;
  onError: (msg: string) => void;
}

const PHASES: { id: Phase; label: string }[] = [
  { id: 1, label: "Iniciando conexión" },
  { id: 2, label: "Autenticando" },
  { id: 3, label: "Extrayendo movimientos" },
  { id: 4, label: "Procesando datos" },
  { id: 5, label: "Completado" },
];

const INACTIVITY_TIMEOUT_MS = 45_000;

export default function ScrapeProgress({ bankId, bankName, agentic = false, onDone, onError }: Props) {
  const [currentPhase, setCurrentPhase] = useState<Phase>(1);
  const [currentMessage, setCurrentMessage] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [needs2FA, setNeeds2FA] = useState(false);
  const [agenticSearching, setAgenticSearching] = useState(false);
  const [agenticFound, setAgenticFound] = useState(false);
  const [twoFACode, setTwoFACode] = useState("");
  const [submitting2FA, setSubmitting2FA] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needs2FARef = useRef(false);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setErrorMsg("La conexión con el servidor se perdió. Reintenta.");
    }, INACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    setCurrentPhase(1);
    setCurrentMessage("");
    setErrorMsg(null);
    setDone(false);
    setNeeds2FA(false);
    setAgenticSearching(false);
    setAgenticFound(false);
    needs2FARef.current = false;
    setTwoFACode("");
    setSubmitting2FA(false);

    const es = new EventSource(`/api/scrape/${bankId}${agentic ? '?mode=agentic' : ''}`);
    esRef.current = es;
    resetInactivityTimer();

    es.onmessage = (e) => {
      resetInactivityTimer();

      const data = JSON.parse(e.data) as PhaseEvent & { keepalive?: boolean };
      if (data.keepalive) return;

      if (data.error) {
        setErrorMsg(data.message ?? "Error inesperado");
        setCurrentPhase(data.phase);
        setNeeds2FA(false);
        setAgenticSearching(false);
        needs2FARef.current = false;
        es.close();
        return;
      }

      if (data.requires_2fa) {
        needs2FARef.current = true;
        setCurrentPhase(data.phase);
        if (data.message) setCurrentMessage(data.message);

        if (data.agentic === true) {
          setAgenticSearching(true);
          setAgenticFound(false);
          setNeeds2FA(false);
          if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
          inactivityTimerRef.current = setTimeout(() => {
            es.close();
            setErrorMsg("Tiempo de espera agotado buscando código en Gmail.");
          }, 120_000);
        } else {
          setAgenticSearching(false);
          setNeeds2FA(true);
          if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
          inactivityTimerRef.current = setTimeout(() => {
            es.close();
            setErrorMsg("Tiempo de espera agotado para el código 2FA.");
          }, 120_000);
          setTimeout(() => codeInputRef.current?.focus(), 100);
        }
        return;
      }

      if (data.message === "Código encontrado — verificando...") {
        setAgenticSearching(false);
        setAgenticFound(true);
        setTimeout(() => setAgenticFound(false), 2000);
      }

      if (needs2FARef.current && data.phase > 2) {
        setNeeds2FA(false);
        setAgenticSearching(false);
        needs2FARef.current = false;
      }

      setCurrentPhase(data.phase);
      if (data.message) setCurrentMessage(data.message);

      if (data.done) {
        setDone(true);
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
        es.close();
        setTimeout(onDone, 1500);
      }
    };

    es.onerror = () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      setErrorMsg("Conexión interrumpida — intenta de nuevo");
      es.close();
    };

    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      es.close();
    };
  }, [bankId, agentic, retryCount, resetInactivityTimer]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit2FACode = async () => {
    if (!twoFACode.trim() || submitting2FA) return;
    setSubmitting2FA(true);
    try {
      await fetch(`/api/2fa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankId, code: twoFACode.trim() }),
      });
      setNeeds2FA(false);
      setCurrentMessage("Código enviado — verificando...");
      resetInactivityTimer();
    } catch {
      setErrorMsg("Error al enviar código");
    } finally {
      setSubmitting2FA(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />

      {/* Pulsing glow */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 500,
          height: 500,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(15,118,110,0.08) 0%, transparent 70%)",
          animation: "pulse-glow 3s ease-in-out infinite",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
      />

      <div className="relative z-10 w-full max-w-sm mx-4 bg-white rounded-3xl border border-slate-200 shadow-xl p-8">
        {/* Bank header */}
        <div className="text-center mb-10">
          <div className="w-12 h-12 rounded-2xl bg-teal-50 border border-teal-200 flex items-center justify-center mx-auto mb-3">
            <span className="text-xl font-bold text-teal-700">{bankName[0]}</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">{bankName}</h2>
          <p className="text-slate-400 text-sm mt-1">Sincronizando movimientos</p>
        </div>

        {/* Phase list */}
        <div className="relative flex flex-col gap-0">
          {PHASES.map((phase, i) => {
            const isActive = currentPhase === phase.id && !done && !errorMsg;
            const isCompleted = done ? true : phase.id < currentPhase;
            const isError = !!errorMsg && phase.id === currentPhase;
            const isPending = !isActive && !isCompleted && !isError;

            return (
              <div key={phase.id} className="flex gap-4 items-start">
                <div className="flex flex-col items-center" style={{ width: 28, flexShrink: 0 }}>
                  <PhaseNode state={isError ? "error" : isCompleted ? "done" : isActive ? "active" : "pending"} />
                  {i < PHASES.length - 1 && (
                    <div className="w-px flex-1 my-1" style={{ minHeight: 28 }}>
                      <div
                        className="w-full h-full rounded-full transition-colors duration-500"
                        style={{ background: isCompleted ? "#0f766e" : "#e2e8f0" }}
                      />
                    </div>
                  )}
                </div>

                <div className="pb-7 pt-0.5">
                  <p
                    className="text-sm font-semibold transition-colors duration-300"
                    style={{ color: isPending ? "#cbd5e1" : isError ? "#e11d48" : "#0f172a" }}
                  >
                    {phase.label}
                  </p>
                  {isActive && currentMessage && (
                    <p className="text-xs text-teal-600 mt-0.5">{currentMessage}</p>
                  )}
                  {isError && (
                    <p className="text-xs text-rose-500 mt-0.5">{errorMsg}</p>
                  )}
                  {isCompleted && phase.id === 5 && (
                    <p className="text-xs text-teal-600 mt-0.5">{currentMessage}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Agentic 2FA: searching Gmail */}
        {agenticSearching && !errorMsg && (
          <div className="mt-4 mb-2 flex items-center gap-3 px-4 py-3 rounded-xl bg-teal-50 border border-teal-200">
            <svg
              className="w-5 h-5 text-teal-600 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              style={{ animation: "agentic-pulse 1.5s ease-in-out infinite" }}
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="text-sm text-teal-700">Buscando código en Gmail...</span>
          </div>
        )}

        {/* Agentic 2FA: code found flash */}
        {agenticFound && !errorMsg && (
          <div className="mt-4 mb-2 flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200">
            <svg className="w-5 h-5 text-emerald-600 shrink-0" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path d="M8 12l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-sm text-emerald-600">Código encontrado — verificando...</span>
          </div>
        )}

        {/* 2FA code input (manual mode) */}
        {needs2FA && !errorMsg && (
          <div className="mt-4 mb-2">
            <p className="text-sm text-slate-500 mb-2">{currentMessage}</p>
            <div className="flex gap-2">
              <input
                ref={codeInputRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                placeholder="Código de verificación"
                value={twoFACode}
                onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && submit2FACode()}
                className="flex-1 px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 text-center text-lg tracking-[0.3em] font-[family-name:var(--font-geist-mono)] placeholder:text-slate-300 placeholder:tracking-normal placeholder:text-sm focus:outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400"
              />
              <button
                onClick={submit2FACode}
                disabled={!twoFACode.trim() || submitting2FA}
                className="px-5 py-2.5 rounded-xl bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting2FA ? "..." : "Enviar"}
              </button>
            </div>
          </div>
        )}

        {/* Actions on error */}
        {errorMsg && /invalid|incorrecta|credential|clave|password|usuario/i.test(errorMsg) && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-slate-500 text-center">Las credenciales guardadas no funcionaron.</p>
            <Link
              href={`/banks?add=${bankId}`}
              className="block w-full py-2.5 rounded-full bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 transition-colors text-center"
            >
              Actualizar credenciales
            </Link>
            <button
              onClick={() => onError(errorMsg)}
              className="w-full py-2 rounded-full border border-slate-200 text-sm text-slate-400 hover:text-slate-700 transition-colors"
            >
              Cerrar
            </button>
          </div>
        )}
        {errorMsg && !/invalid|incorrecta|credential|clave|password|usuario/i.test(errorMsg) && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => setRetryCount((c) => c + 1)}
              className="flex-1 py-2.5 rounded-full bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 transition-colors"
            >
              Reintentar
            </button>
            <button
              onClick={() => onError(errorMsg)}
              className="px-5 py-2.5 rounded-full border border-slate-200 text-sm text-slate-400 hover:text-slate-700 transition-colors"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes pulse-glow {
          0%, 100% { opacity: 0.7; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
        }
        @keyframes spin-arc {
          to { transform: rotate(360deg); }
        }
        @keyframes ring-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(15,118,110,0.3); }
          50% { box-shadow: 0 0 0 6px rgba(15,118,110,0); }
        }
        @keyframes agentic-pulse {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}

function PhaseNode({ state }: { state: "pending" | "active" | "done" | "error" }) {
  if (state === "done") {
    return (
      <div className="w-7 h-7 rounded-full bg-teal-700 flex items-center justify-center flex-shrink-0">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="w-7 h-7 rounded-full bg-rose-50 border-2 border-rose-500 flex items-center justify-center flex-shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-rose-500" />
      </div>
    );
  }
  if (state === "active") {
    return (
      <div
        className="w-7 h-7 rounded-full border-2 border-teal-600 flex items-center justify-center flex-shrink-0 relative"
        style={{ animation: "ring-pulse 1.5s ease-in-out infinite" }}
      >
        <div
          className="absolute inset-0.5 rounded-full border-2 border-transparent border-t-teal-600"
          style={{ animation: "spin-arc 0.8s linear infinite" }}
        />
        <div className="w-1.5 h-1.5 rounded-full bg-teal-600" />
      </div>
    );
  }
  return <div className="w-7 h-7 rounded-full border-2 border-slate-200 flex-shrink-0" />;
}
