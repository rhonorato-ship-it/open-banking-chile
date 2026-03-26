import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = SupabaseClient<any>;

// Client is created lazily so the build doesn't fail when env vars aren't set at build time.
let _client: ReturnType<typeof createClient> | null = null;

export function getDb() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// Convenience re-export for call sites that already imported `supabase`
export const supabase = new Proxy({} as AnyDb, {
  get(_, prop) {
    return Reflect.get(getDb(), prop);
  },
});
