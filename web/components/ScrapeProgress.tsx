"use client";

import { useEffect, useRef, useState } from "react";

type Phase = 1 | 2 | 3 | 4 | 5;

interface PhaseEvent {
  phase: Phase;
  label?: string;
  message?: string;
  done?: boolean;
  error?: boolean;
}

interface Props {
  bankId: string;
  bankName: string;
  onDone: () => void;
  onError: (msg: string) => void;
}

const PHASES: { id: Phase; label: string; sub: string }[] = [
  { id: 1, label: "Iniciando conexión", sub: "Abriendo sesión segura" },
  { id: 2, label: "Autenticando", sub: "Verificando credenciales" },
  { id: 3, label: "Extrayendo movimientos", sub: "Leyendo tu historial" },
  { id: 4, label: "Procesando datos", sub: "Guardando y deduplicando" },
  { id: 5, label: "Completado", sub: "" },
];

export default function ScrapeProgress({ bankId, bankName, onDone, onError }: Props) {
  const [currentPhase, setCurrentPhase] = useState<Phase>(1);
  const [currentMessage, setCurrentMessage] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/scrape/${bankId}`);
    esRef.current = es;

    es.onmessage = (e) => {
      const data: PhaseEvent = JSON.parse(e.data);

      if (data.error) {
        setErrorMsg(data.message ?? "Error inesperado");
        setCurrentPhase(data.phase);
        es.close();
        return;
      }

      setCurrentPhase(data.phase);
      if (data.message) setCurrentMessage(data.message);

      if (data.done) {
        setDone(true);
        es.close();
        setTimeout(onDone, 1500);
      }
    };

    es.onerror = () => {
      if (!done && !errorMsg) {
        setErrorMsg("Conexión interrumpida — intenta de nuevo");
      }
      es.close();
    };

    return () => es.close();
  }, [bankId]); // eslint-disable-line react-hooks/exhaustive-deps

  const completedPhases = done ? 5 : currentPhase - 1;
  const progressPct = Math.min(((completedPhases) / 4) * 100, 100);

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
                {/* Node + connector */}
                <div className="flex flex-col items-center" style={{ width: 28, flexShrink: 0 }}>
                  <PhaseNode
                    state={isError ? "error" : isCompleted ? "done" : isActive ? "active" : "pending"}
                  />
                  {i < PHASES.length - 1 && (
                    <div className="w-px flex-1 my-1" style={{ minHeight: 28 }}>
                      <div
                        className="w-full h-full rounded-full transition-colors duration-500"
                        style={{ background: isCompleted ? "#0ea5e9" : "rgba(255,255,255,0.1)" }}
                      />
                    </div>
                  )}
                </div>

                {/* Label */}
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

        {/* Retry button on error */}
        {errorMsg && (
          <button
            onClick={() => window.location.reload()}
            className="mt-2 w-full py-2.5 rounded-full border border-white/10 text-sm font-medium hover:bg-white/5 transition-colors"
          >
            Reintentar
          </button>
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
        {/* Spinning arc */}
        <div
          className="absolute inset-0.5 rounded-full border-2 border-transparent border-t-[#0ea5e9]"
          style={{ animation: "spin-arc 0.8s linear infinite" }}
        />
        <div className="w-1.5 h-1.5 rounded-full bg-[#0ea5e9]" />
      </div>
    );
  }

  // pending
  return (
    <div className="w-7 h-7 rounded-full border-2 border-white/15 flex-shrink-0" />
  );
}
