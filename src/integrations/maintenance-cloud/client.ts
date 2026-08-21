/**
 * Cloud Supabase client — maintenance control plane ONLY.
 *
 * This is a COMPLETELY SEPARATE Supabase project from the one PesoWise's
 * normal application uses (src/integrations/supabase/client.ts). Never
 * import that file here, and never import this file from there or from
 * any normal-application code path.
 *
 * Publishable (anon) key only — never a service_role key, secret key, or
 * database password. See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md
 * Decision F.
 *
 * The client is lazily constructed and may be `null` when the feature is
 * disabled or unconfigured — every caller must handle that (fail open).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const MAINTENANCE_SUPABASE_URL = import.meta.env.VITE_MAINTENANCE_SUPABASE_URL as
  | string
  | undefined;
const MAINTENANCE_SUPABASE_PUBLISHABLE_KEY = import.meta.env
  .VITE_MAINTENANCE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

/** Distinct storage key so a Cloud Auth session can never collide with, or be
 * swept by, the local PesoWise Supabase client's own token-cleanup logic
 * (which matches on project-ref substrings — see src/lib/authSession.ts). */
const MAINTENANCE_AUTH_STORAGE_KEY = "pw-maintenance-cloud-auth";

export function isMaintenanceCloudConfigured(): boolean {
  return Boolean(MAINTENANCE_SUPABASE_URL && MAINTENANCE_SUPABASE_PUBLISHABLE_KEY);
}

let cachedClient: SupabaseClient | null | undefined;

/**
 * Returns the Cloud maintenance Supabase client, or `null` when the two
 * required env vars are not both set. Never throws — callers must treat a
 * `null` client the same as any other Cloud failure (fail open).
 */
export function getMaintenanceSupabase(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient;

  if (!isMaintenanceCloudConfigured()) {
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = createClient(
    MAINTENANCE_SUPABASE_URL as string,
    MAINTENANCE_SUPABASE_PUBLISHABLE_KEY as string,
    {
      auth: {
        storageKey: MAINTENANCE_AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    },
  );
  return cachedClient;
}

/** Test seam — resets the cached client so tests can re-evaluate env vars. */
export function resetMaintenanceSupabaseCacheForTests(): void {
  cachedClient = undefined;
}
