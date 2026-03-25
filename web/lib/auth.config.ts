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
    async signIn({ account }) {
      return account?.provider === "google";
    },
    async jwt({ token, account, user }) {
      if (account) token.sub = user?.id ?? account.providerAccountId;
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.sub!;
      return session;
    },
  },
} satisfies NextAuthConfig;
