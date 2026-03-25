import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

// Edge-compatible auth config — no DB imports.
// Used by middleware. Full auth (with DB upsert) is in auth.ts.
export const authConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  ],
  session: { strategy: "jwt" as const },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google" || !user.email) return false;
      const whitelist = process.env.AUTH_WHITELIST_EMAILS?.split(",").map((e) => e.trim()) ?? [];
      if (whitelist.length > 0 && !whitelist.includes(user.email)) return false;
      return true;
    },
    async jwt({ token, account, user }) {
      if (account && user) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.sub!;
      return session;
    },
  },
} satisfies NextAuthConfig;
