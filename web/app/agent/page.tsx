"use client";

import { useState } from "react";
import Navigation from "@/components/Navigation";
import AgentStatus from "@/components/AgentStatus";

export default function AgentPage() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
            Sincroniza tus bancos desde tu computador, sin compartir credenciales
            con la nube.
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

        {/* Token generation */}
        <section className="p-5 rounded-2xl border border-slate-200 bg-white">
          <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">
            Token de autenticacion
          </p>
          <p className="text-sm text-slate-500 mb-4">
            Este token permite al agente local sincronizar datos con tu cuenta.
            Guardalo de forma segura y no lo compartas.
          </p>

          {!token ? (
            <button
              onClick={generateToken}
              disabled={loading}
              className="px-5 py-2.5 rounded-xl bg-teal-600 text-white text-sm font-bold hover:bg-teal-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Generando..." : "Generar token"}
            </button>
          ) : (
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
                disabled={loading}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                {loading ? "Generando..." : "Regenerar token"}
              </button>
            </div>
          )}

          {error && (
            <p className="text-xs text-rose-500 mt-3">{error}</p>
          )}
        </section>

        {/* Setup instructions */}
        <section className="p-5 rounded-2xl border border-slate-200 bg-white">
          <p className="text-xs text-slate-400 uppercase tracking-[0.15em] mb-3">
            Instrucciones de instalacion
          </p>

          <div className="space-y-5">
            {/* Step 1 */}
            <div>
              <div className="flex items-center gap-2.5 mb-2">
                <div className="w-6 h-6 rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center">
                  <span className="text-xs font-bold text-teal-700">1</span>
                </div>
                <p className="text-sm font-semibold text-slate-700">
                  Instala el paquete
                </p>
              </div>
              <pre className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs font-[family-name:var(--font-geist-mono)] text-slate-600">
                npm install -g open-banking-chile
              </pre>
            </div>

            {/* Step 2 */}
            <div>
              <div className="flex items-center gap-2.5 mb-2">
                <div className="w-6 h-6 rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center">
                  <span className="text-xs font-bold text-teal-700">2</span>
                </div>
                <p className="text-sm font-semibold text-slate-700">
                  Crea un archivo de credenciales
                </p>
              </div>
              <p className="text-xs text-slate-400 mb-2 ml-8">
                Crea un archivo <code className="font-[family-name:var(--font-geist-mono)] bg-slate-100 px-1 py-0.5 rounded">credentials.env</code> con
                tus credenciales bancarias:
              </p>
              <pre className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs font-[family-name:var(--font-geist-mono)] text-slate-600 leading-relaxed">
{`# credentials.env
BCHILE_RUT=12345678-9
BCHILE_PASS=tu_clave

SANTANDER_RUT=12345678-9
SANTANDER_PASS=tu_clave`}
              </pre>
            </div>

            {/* Step 3 */}
            <div>
              <div className="flex items-center gap-2.5 mb-2">
                <div className="w-6 h-6 rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center">
                  <span className="text-xs font-bold text-teal-700">3</span>
                </div>
                <p className="text-sm font-semibold text-slate-700">
                  Ejecuta el agente
                </p>
              </div>
              <pre className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs font-[family-name:var(--font-geist-mono)] text-slate-600 leading-relaxed">
{`npx open-banking-chile serve \\
  --token ${token ? token.slice(0, 20) + "..." : "<tu-token>"}`}
              </pre>
            </div>
          </div>

          <div className="mt-5 p-3 rounded-xl bg-teal-50 border border-teal-200">
            <p className="text-xs text-teal-700 leading-relaxed">
              El agente se conecta a Supabase Realtime y espera instrucciones de
              sincronizacion. Tus credenciales nunca salen de tu computador --
              solo los movimientos procesados se suben a la nube.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
