import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { supabase } from "./db";

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
          const { error } = await supabase.from("users").upsert(
            { id, email: user.email, name: user.name ?? null, image: user.image ?? null },
            { onConflict: "id" },
          );
          if (error) {
            console.error("[auth] user upsert failed:", error);
            return false;
          }
        } catch (e) {
          console.error("[auth] user upsert exception:", e);
          return false;
        }
      }
      return true;
    },
  },
});
