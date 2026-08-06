import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient() {
  if (typeof window === "undefined") {
    return null;
  }

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://xrltntqkwckdshmyvdjb.supabase.co";
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    "sb_publishable_7u0H1nFaH7ybaXV2rhx2KQ_otS5VErj";

  browserClient ??= createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });

  return browserClient;
}

export function isSupabaseConfigured() {
  return true;
}

