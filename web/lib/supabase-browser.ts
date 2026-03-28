import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser-side Supabase client for Realtime subscriptions.
// Uses NEXT_PUBLIC_ env vars (exposed to the browser), falling back to
// server-only SUPABASE_URL / SUPABASE_ANON_KEY if the public variants aren't set.
// Singleton — returns the same client instance across the app.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: SupabaseClient<any> | null = null;

export function getSupabaseBrowser() {
  if (_client) return _client;

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    "";

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }

  _client = createClient(url, key, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  return _client;
}

export const supabaseBrowser = new Proxy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  {} as SupabaseClient<any>,
  {
    get(_, prop) {
      return Reflect.get(getSupabaseBrowser(), prop);
    },
  },
);
