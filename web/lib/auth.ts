import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { db } from "./db";
import { users } from "./schema";
import { eq } from "drizzle-orm";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google" || !user.id || !user.email) return false;
      const whitelist = process.env.AUTH_WHITELIST_EMAILS?.split(",").map((e) => e.trim()) ?? [];
      if (whitelist.length > 0 && !whitelist.includes(user.email)) return false;
      // Upsert user row — JWT mode has no DB adapter, so we manage it manually
      await db
        .insert(users)
        .values({ id: user.id, email: user.email, name: user.name ?? null, image: user.image ?? null })
        .onConflictDoUpdate({
          target: users.id,
          set: { name: user.name ?? null, image: user.image ?? null },
        });
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
});
