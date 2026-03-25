import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { db } from "./db";
import { users } from "./schema";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }) {
      // Run edge-compatible checks first (whitelist, provider)
      const allowed = await authConfig.callbacks.signIn({ user, account, credentials: undefined, email: undefined, profile: undefined });
      if (!allowed) return false;
      // Upsert user row — JWT mode has no DB adapter, so we manage it manually
      await db
        .insert(users)
        .values({ id: user.id!, email: user.email!, name: user.name ?? null, image: user.image ?? null })
        .onConflictDoUpdate({
          target: users.id,
          set: { name: user.name ?? null, image: user.image ?? null },
        });
      return true;
    },
  },
});
