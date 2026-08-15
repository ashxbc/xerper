import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase wiring.
 *
 * The website never talks to Supabase from the browser: every read goes
 * through our own API routes (e.g. /api/gems), and those routes use the
 * service-role key server-side, which bypasses Row Level Security. That means
 * no RLS policies are required, and the service-role key must never be
 * exposed to the client (it is not NEXT_PUBLIC).
 *
 * If the env vars are missing the app degrades gracefully: reads fall back to
 * the in-memory scan cache and the cron endpoint refuses to run.
 */

let cachedClient: SupabaseClient | undefined;

/** True when the server-side Supabase configuration is present. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim() &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim(),
  );
}

/** Server-side client (service-role key). Cached per instance. */
export function serverClient(): SupabaseClient {
  if (cachedClient !== undefined) return cachedClient;

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase is not configured - set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY environment variables",
    );
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return cachedClient;
}
