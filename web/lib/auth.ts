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
      if (!user.email) return false;

      const id = user.id ?? account.providerAccountId;
      if (id) {
        try {
          await db
            .insert(users)
            .values({ id, email: user.email, name: user.name ?? null, image: user.image ?? null })
            .onConflictDoUpdate({
              target: users.id,
              set: {
                email: user.email,
                name: user.name ?? null,
                image: user.image ?? null,
              },
            });
        } catch (e) {
          console.error("[auth] user upsert failed:", e);
          return false;
        }
      }
      return true;
    },
  },
});
