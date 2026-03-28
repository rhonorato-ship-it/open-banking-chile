import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Open Banking Chile",
  description: "Sincroniza tus movimientos bancarios",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className={`${geistSans.variable} ${geistMono.variable} font-[family-name:var(--font-geist-sans)] bg-[#f5f8f8] text-slate-900 antialiased`}>
        {children}
      </body>
    </html>
  );
}
