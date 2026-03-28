"use client";

import { useState, useEffect } from "react";
import Navigation from "@/components/Navigation";
import AgentStatus from "@/components/AgentStatus";

export default function AgentPage() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Auto-generate token on page load
  useEffect(() => {
    generateToken();
  }, []);

  async function generateToken() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/agent/token", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Error al generar token");
      }
      const data = await res.json();
      setToken(data.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  }

  return (
    <div className="min-h-screen bg-[#f5f8f8]">
      <Navigation />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        {/* Page header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Agente local
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Sincroniza tus bancos desde tu computador.
            Las credenciales se sincronizan desde tu cuenta. No necesitas configurar nada localmente.
          </p>
        </div>

        {/* Agent status */}
        <section className="p-5 rounded-2xl border border-slate-200 bg-white">
          <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">
            Estado del agente
          </p>
          <div className="flex items-center gap-3">
            <AgentStatus />
          </div>
        </section>

        {/* Token + one-step setup */}
        <section className="p-5 rounded-2xl border border-slate-200 bg-white">
          <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">
            Token de autenticacion
          </p>

          {loading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-16 bg-slate-100 rounded-xl" />
            </div>
          ) : token ? (
            <div className="space-y-3">
              <div className="relative">
                <pre className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs font-[family-name:var(--font-geist-mono)] text-slate-700 break-all whitespace-pre-wrap select-all leading-relaxed">
                  {token}
                </pre>
                <button
                  onClick={copyToken}
                  className="absolute top-2 right-2 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-500 hover:text-slate-700 hover:border-slate-300 transition-colors"
                >
                  {copied ? "Copiado" : "Copiar"}
                </button>
              </div>
              <button
                onClick={generateToken}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                Regenerar token
              </button>
            </div>
          ) : null}

          {error && (
            <p className="text-xs text-rose-500 mt-3">{error}</p>
          )}
        </section>

        {/* Setup instructions — single step */}
        <section className="p-5 rounded-2xl border border-slate-200 bg-white">
          <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">
            Como empezar
          </p>

          <div className="space-y-4">
            <div>
              <p className="text-sm text-slate-500 mb-3">
                Ejecuta este comando en tu terminal. El agente te pedira el token automaticamente.
              </p>
              <pre className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs font-[family-name:var(--font-geist-mono)] text-slate-600 leading-relaxed">
                npx open-banking-chile serve
              </pre>
            </div>

            <div className="p-3 rounded-xl bg-teal-50 border border-teal-200">
              <p className="text-xs text-teal-700 leading-relaxed">
                Las credenciales bancarias se sincronizan automaticamente desde tu cuenta.
                No necesitas crear archivos de configuracion ni variables de entorno.
                Solo ejecuta el comando y pega el token cuando te lo pida.
              </p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
