import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { db } from "./db";
import { users } from "./schema";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }) {
      if (account?.provider !== "google") return false;
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
