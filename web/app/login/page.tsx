"use client";

import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#f5f8f8]">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "radial-gradient(ellipse 60% 50% at 50% 60%, rgba(15,118,110,0.08) 0%, transparent 70%)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-8 px-6 text-center">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-teal-700" />
          <span className="text-xl font-bold tracking-tight text-slate-900">Open Banking Chile</span>
        </div>

        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">Tus movimientos,</h1>
          <h1 className="text-4xl font-bold tracking-tight text-teal-700">en un solo lugar.</h1>
          <p className="text-slate-400 text-sm mt-3">
            Conecta tus cuentas bancarias y sincroniza tu historial automáticamente.
          </p>
        </div>

        <button
          onClick={() => signIn("google", { callbackUrl: "/dashboard" })}
          className="flex items-center gap-3 bg-slate-900 text-white font-semibold px-6 py-3 rounded-full hover:bg-slate-800 transition-colors text-sm shadow-sm"
        >
          <GoogleIcon />
          Continuar con Google
        </button>

        <p className="text-slate-300 text-xs max-w-xs">
          Tus credenciales bancarias se almacenan encriptadas con AES-256 y nunca son accesibles por terceros.
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}
