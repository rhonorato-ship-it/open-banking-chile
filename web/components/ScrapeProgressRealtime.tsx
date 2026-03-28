"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase-browser";

type Phase = 1 | 2 | 3 | 4 | 5;

interface PhaseEvent {
  phase: Phase;
  label?: string;
  message?: string;
  done?: boolean;
  error?: boolean;
  requires_2fa?: boolean;
}

interface Props {
  taskId: string;
  bankName: string;
  onDone: () => void;
  onError: (msg: string) => void;
}

const PHASES: { id: Phase; label: string }[] = [
  { id: 1, label: "Iniciando conexion" },
  { id: 2, label: "Autenticando" },
  { id: 3, label: "Extrayendo movimientos" },
  { id: 4, label: "Procesando datos" },
  { id: 5, label: "Completado" },
];

const INACTIVITY_TIMEOUT_MS = 120_000; // 2 min for agent (may be slower than server-side)

/**
 * Maps a sync_tasks row to the PhaseEvent shape used by the progress UI.
 */
function rowToPhaseEvent(row: Record<string, unknown>): PhaseEvent {
  const status = row.status as string | undefined;
  const phase = (row.current_phase as number | undefined) ?? 1;
  const message = (row.status_message as string | undefined) ?? "";

  return {
    phase: Math.max(1, Math.min(5, phase)) as Phase,
    message,
    done: status === "done",
    error: status === "error",
    requires_2fa: status === "requires_2fa",
  };
}

export default function ScrapeProgressRealtime({
  taskId,
  bankName,
  onDone,
  onError,
}: Props) {
  const [currentPhase, setCurrentPhase] = useState<Phase>(1);
  const [currentMessage, setCurrentMessage] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [needs2FA, setNeeds2FA] = useState(false);
  const [twoFACode, setTwoFACode] = useState("");
  const [submitting2FA, setSubmitting2FA] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needs2FARef = useRef(false);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      setErrorMsg("La conexion con el agente se perdio. Reintenta.");
    }, INACTIVITY_TIMEOUT_MS);
  }, []);

  const handleEvent = useCallback(
    (data: PhaseEvent) => {
      resetInactivityTimer();

      if (data.error) {
        setErrorMsg(data.message ?? "Error inesperado");
        setCurrentPhase(data.phase);
        setNeeds2FA(false);
        needs2FARef.current = false;
        return;
      }

      if (data.requires_2fa) {
        needs2FARef.current = true;
        setCurrentPhase(data.phase);
        if (data.message) setCurrentMessage(data.message);
        setNeeds2FA(true);
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = setTimeout(() => {
          setErrorMsg("Tiempo de espera agotado para el codigo 2FA.");
        }, 120_000);
        setTimeout(() => codeInputRef.current?.focus(), 100);
        return;
      }

      if (needs2FARef.current && data.phase > 2) {
        setNeeds2FA(false);
        needs2FARef.current = false;
      }

      setCurrentPhase(data.phase);
      if (data.message) setCurrentMessage(data.message);

      if (data.done) {
        setDone(true);
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
        setTimeout(onDone, 1500);
      }
    },
    [onDone, resetInactivityTimer],
  );

  useEffect(() => {
    // Reset state
    setCurrentPhase(1);
    setCurrentMessage("");
    setErrorMsg(null);
    setDone(false);
    setNeeds2FA(false);
    needs2FARef.current = false;
    setTwoFACode("");
    setSubmitting2FA(false);

    resetInactivityTimer();

    // Initial fetch of current task state
    (async () => {
      const { data } = await supabaseBrowser
        .from("sync_tasks")
        .select("*")
        .eq("id", taskId)
        .single();

      if (data) {
        handleEvent(rowToPhaseEvent(data));
      }
    })();

    // Subscribe to UPDATE events for this task
    const channel = supabaseBrowser
      .channel(`sync-task-${taskId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "sync_tasks",
          filter: `id=eq.${taskId}`,
        },
        (payload) => {
          if (payload.new) {
            handleEvent(rowToPhaseEvent(payload.new as Record<string, unknown>));
          }
        },
      )
      .subscribe();

    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
      supabaseBrowser.removeChannel(channel);
    };
  }, [taskId, handleEvent, resetInactivityTimer]);

  const submit2FACode = async () => {
    if (!twoFACode.trim() || submitting2FA) return;
    setSubmitting2FA(true);
    try {
      await fetch(`/api/2fa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, code: twoFACode.trim() }),
      });
      setNeeds2FA(false);
      setCurrentMessage("Codigo enviado -- verificando...");
      resetInactivityTimer();
    } catch {
      setErrorMsg("Error al enviar codigo");
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
          background:
            "radial-gradient(circle, rgba(15,118,110,0.08) 0%, transparent 70%)",
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
            <span className="text-xl font-bold text-teal-700">
              {bankName[0]}
            </span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">
            {bankName}
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            Sincronizando via agente local
          </p>
        </div>

        {/* Phase list */}
        <div className="relative flex flex-col gap-0">
          {PHASES.map((phase, i) => {
            const isActive =
              currentPhase === phase.id && !done && !errorMsg;
            const isCompleted = done ? true : phase.id < currentPhase;
            const isError = !!errorMsg && phase.id === currentPhase;
            const isPending = !isActive && !isCompleted && !isError;

            return (
              <div key={phase.id} className="flex gap-4 items-start">
                <div
                  className="flex flex-col items-center"
                  style={{ width: 28, flexShrink: 0 }}
                >
                  <PhaseNode
                    state={
                      isError
                        ? "error"
                        : isCompleted
                          ? "done"
                          : isActive
                            ? "active"
                            : "pending"
                    }
                  />
                  {i < PHASES.length - 1 && (
                    <div
                      className="w-px flex-1 my-1"
                      style={{ minHeight: 28 }}
                    >
                      <div
                        className="w-full h-full rounded-full transition-colors duration-500"
                        style={{
                          background: isCompleted ? "#0f766e" : "#e2e8f0",
                        }}
                      />
                    </div>
                  )}
                </div>

                <div className="pb-7 pt-0.5">
                  <p
                    className="text-sm font-semibold transition-colors duration-300"
                    style={{
                      color: isPending
                        ? "#cbd5e1"
                        : isError
                          ? "#e11d48"
                          : "#0f172a",
                    }}
                  >
                    {phase.label}
                  </p>
                  {isActive && currentMessage && (
                    <p className="text-xs text-teal-600 mt-0.5">
                      {currentMessage}
                    </p>
                  )}
                  {isError && (
                    <p className="text-xs text-rose-500 mt-0.5">{errorMsg}</p>
                  )}
                  {isCompleted && phase.id === 5 && (
                    <p className="text-xs text-teal-600 mt-0.5">
                      {currentMessage}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* 2FA code input */}
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
                placeholder="Codigo de verificacion"
                value={twoFACode}
                onChange={(e) =>
                  setTwoFACode(e.target.value.replace(/\D/g, ""))
                }
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
        {errorMsg &&
          /invalid|incorrecta|credential|clave|password|usuario|autenticaci/i.test(
            errorMsg,
          ) && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-slate-500 text-center">
                Las credenciales guardadas no funcionaron.
              </p>
              <Link
                href="/banks"
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
        {errorMsg &&
          !/invalid|incorrecta|credential|clave|password|usuario|autenticaci/i.test(
            errorMsg,
          ) && (
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => onError(errorMsg)}
                className="flex-1 py-2.5 rounded-full bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 transition-colors"
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
      `}</style>
    </div>
  );
}

function PhaseNode({
  state,
}: {
  state: "pending" | "active" | "done" | "error";
}) {
  if (state === "done") {
    return (
      <div className="w-7 h-7 rounded-full bg-teal-700 flex items-center justify-center flex-shrink-0">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 6l3 3 5-5"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
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
  return (
    <div className="w-7 h-7 rounded-full border-2 border-slate-200 flex-shrink-0" />
  );
}
