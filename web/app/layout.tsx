import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Open Banking Chile",
  description: "Sincroniza tus movimientos bancarios",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="bg-[#050505] text-white antialiased">{children}</body>
    </html>
  );
}
