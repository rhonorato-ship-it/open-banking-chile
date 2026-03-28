"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";

const NAV_LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/movements", label: "Movimientos" },
  { href: "/analytics", label: "Analítica" },
  { href: "/banks", label: "Cuentas" },
];

export default function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-slate-200 px-6 h-14 flex items-center justify-between sticky top-0 bg-white/90 backdrop-blur-sm z-10">
      <Link href="/dashboard" className="flex items-center gap-2.5">
        <div className="w-5 h-5 rounded-full bg-teal-700" />
        <span className="font-semibold text-sm tracking-tight">Open Banking Chile</span>
      </Link>
      <div className="flex items-center gap-1">
        {NAV_LINKS.map((link) => {
          const isActive = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
                isActive
                  ? "text-teal-700 font-semibold bg-teal-50"
                  : "text-slate-400 hover:text-slate-600"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="text-sm text-slate-300 hover:text-slate-500 transition-colors ml-3 px-2"
        >
          Salir
        </button>
      </div>
    </nav>
  );
}
