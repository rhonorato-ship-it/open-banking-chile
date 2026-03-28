"use client";

import { useEffect, useRef, useState, useCallback } from "react";

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

/** If no SSE message arrives within this window, assume the connection is dead. */
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

  /** Reset the inactivity timer. Called on every SSE message. */
  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      // No message received for INACTIVITY_TIMEOUT_MS — connection is dead
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setErrorMsg("La conexión con el servidor se perdió. Reintenta.");
    }, INACTIVITY_TIMEOUT_MS);
  }, []);

  useEffect(() => {
    // Reset state on retry
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

    // Start the inactivity timer
    resetInactivityTimer();

    es.onmessage = (e) => {
      // Every message (including keepalives) proves the connection is alive
      resetInactivityTimer();

      const data = JSON.parse(e.data) as PhaseEvent & { keepalive?: boolean };

      // Server keepalive — just reset the timer, nothing else to do
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
          // Agentic mode: server is searching Gmail for the code
          setAgenticSearching(true);
          setAgenticFound(false);
          setNeeds2FA(false);
          // Extend timeout — agentic polling can take a while
          if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
          inactivityTimerRef.current = setTimeout(() => {
            es.close();
            setErrorMsg("Tiempo de espera agotado buscando código en Gmail.");
          }, 120_000);
        } else {
          // Manual mode (or agentic fallback to manual)
          setAgenticSearching(false);
          setNeeds2FA(true);
          // Extend timeout during 2FA (user needs time to get the code)
          if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
          inactivityTimerRef.current = setTimeout(() => {
            es.close();
            setErrorMsg("Tiempo de espera agotado para el código 2FA.");
          }, 120_000); // 2 minutes for 2FA
          setTimeout(() => codeInputRef.current?.focus(), 100);
        }
        return;
      }

      // Agentic: code found message — brief success flash
      if (data.message === "Código encontrado — verificando...") {
        setAgenticSearching(false);
        setAgenticFound(true);
        setTimeout(() => setAgenticFound(false), 2000);
      }

      // If we were waiting for 2FA and moved past phase 2, clear the input
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
      // Restart normal inactivity timer
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
      <div className="absolute inset-0 bg-[#050505]/95 backdrop-blur-sm" />

      {/* Pulsing glow */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(14,165,233,0.13) 0%, transparent 70%)",
          animation: "pulse-glow 3s ease-in-out infinite",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
      />

      <div className="relative z-10 w-full max-w-sm mx-4">
        {/* Bank header */}
        <div className="text-center mb-10">
          <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/10 flex items-center justify-center mx-auto mb-3">
            <span className="text-xl font-bold">{bankName[0]}</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight">{bankName}</h2>
          <p className="text-white/40 text-sm mt-1">Sincronizando movimientos</p>
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
                        style={{ background: isCompleted ? "#0ea5e9" : "rgba(255,255,255,0.1)" }}
                      />
                    </div>
                  )}
                </div>

                <div className="pb-7 pt-0.5">
                  <p
                    className="text-sm font-semibold transition-colors duration-300"
                    style={{ color: isPending ? "rgba(255,255,255,0.3)" : isError ? "#ef4444" : "white" }}
                  >
                    {phase.label}
                  </p>
                  {isActive && currentMessage && (
                    <p className="text-xs text-[#0ea5e9] mt-0.5">{currentMessage}</p>
                  )}
                  {isError && (
                    <p className="text-xs text-red-400 mt-0.5">{errorMsg}</p>
                  )}
                  {isCompleted && phase.id === 5 && (
                    <p className="text-xs text-[#0ea5e9] mt-0.5">{currentMessage}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Agentic 2FA: searching Gmail */}
        {agenticSearching && !errorMsg && (
          <div className="mt-4 mb-2 flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.04] border border-[#0ea5e9]/20">
            <svg
              className="w-5 h-5 text-[#0ea5e9] shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              style={{ animation: "agentic-pulse 1.5s ease-in-out infinite" }}
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="text-sm text-[#0ea5e9]">Buscando código en Gmail...</span>
          </div>
        )}

        {/* Agentic 2FA: code found flash */}
        {agenticFound && !errorMsg && (
          <div className="mt-4 mb-2 flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
            <svg className="w-5 h-5 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
              <path d="M8 12l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="text-sm text-emerald-400">Código encontrado — verificando...</span>
          </div>
        )}

        {/* 2FA code input (manual mode) */}
        {needs2FA && !errorMsg && (
          <div className="mt-4 mb-2">
            <p className="text-sm text-white/60 mb-2">{currentMessage}</p>
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
                className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 border border-white/15 text-white text-center text-lg tracking-[0.3em] font-mono placeholder:text-white/20 placeholder:tracking-normal placeholder:text-sm focus:outline-none focus:border-[#0ea5e9] focus:ring-1 focus:ring-[#0ea5e9]"
              />
              <button
                onClick={submit2FACode}
                disabled={!twoFACode.trim() || submitting2FA}
                className="px-5 py-2.5 rounded-xl bg-[#0ea5e9] text-black text-sm font-bold hover:bg-[#38bdf8] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting2FA ? "..." : "Enviar"}
              </button>
            </div>
          </div>
        )}

        {/* Actions on error */}
        {errorMsg && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => setRetryCount((c) => c + 1)}
              className="flex-1 py-2.5 rounded-full bg-[#0ea5e9] text-black text-sm font-bold hover:bg-[#38bdf8] transition-colors"
            >
              Reintentar
            </button>
            <button
              onClick={() => onError(errorMsg)}
              className="px-5 py-2.5 rounded-full border border-white/10 text-sm text-white/40 hover:text-white transition-colors"
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
          0%, 100% { box-shadow: 0 0 0 0 rgba(14,165,233,0.4); }
          50% { box-shadow: 0 0 0 6px rgba(14,165,233,0); }
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
      <div className="w-7 h-7 rounded-full bg-[#0ea5e9] flex items-center justify-center flex-shrink-0">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="w-7 h-7 rounded-full bg-red-500/20 border-2 border-red-500 flex items-center justify-center flex-shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-red-400" />
      </div>
    );
  }
  if (state === "active") {
    return (
      <div
        className="w-7 h-7 rounded-full border-2 border-[#0ea5e9] flex items-center justify-center flex-shrink-0 relative"
        style={{ animation: "ring-pulse 1.5s ease-in-out infinite" }}
      >
        <div
          className="absolute inset-0.5 rounded-full border-2 border-transparent border-t-[#0ea5e9]"
          style={{ animation: "spin-arc 0.8s linear infinite" }}
        />
        <div className="w-1.5 h-1.5 rounded-full bg-[#0ea5e9]" />
      </div>
    );
  }
  return <div className="w-7 h-7 rounded-full border-2 border-white/15 flex-shrink-0" />;
}
