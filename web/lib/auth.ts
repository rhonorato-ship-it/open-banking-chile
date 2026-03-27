import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { supabase } from "./db";

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, account }) {
      // Only runs on first sign-in (when user and account are present)
      if (account?.provider === "google" && user?.email) {
        try {
          // Reuse existing DB id for this email — avoids id mismatch across sessions
          const { data: existing } = await supabase
            .from("users")
            .select("id")
            .eq("email", user.email)
            .single();

          const id = existing?.id ?? user.id ?? account.providerAccountId;
          console.log("[auth] jwt signin — existing:", existing?.id, "resolved id:", id);

          const { error } = await supabase.from("users").upsert(
            { id, email: user.email, name: user.name ?? null, image: user.image ?? null },
            { onConflict: "id" },
          );
          if (error) console.error("[auth] user upsert failed:", error);
          // Always set userId — don't gate on upsert success (upsert can fail for
          // non-identity reasons like name/image update conflicts)
          token.userId = id;
        } catch (e) {
          console.error("[auth] jwt exception:", e);
        }
      }
      return token;
    },
    async session({ session, token }) {
      // Prefer the resolved DB id over the raw Google sub
      session.user.id = (token.userId as string | undefined) ?? token.sub ?? "";
      return session;
    },
  },
});
