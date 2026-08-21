/**
 * Scoped local-Supabase auth storage cleanup.
 *
 * With the Cloud maintenance control plane, this origin now hosts TWO
 * independent Supabase clients: the local PesoWise client (this module) and
 * the Cloud maintenance client (src/integrations/maintenance-cloud/client.ts,
 * storageKey "pw-maintenance-cloud-auth"). A cleanup routine that matches any
 * "sb-*-auth-token"-shaped key, or any key merely containing the word
 * "auth", is no longer safe — it was written when this origin had only one
 * Supabase project and could delete a session it does not own. This module
 * computes and removes ONLY the exact key(s) belonging to the LOCAL project.
 */

/** The literal localStorage key supabase-js uses by default for a client
 * with no explicit `storageKey` override: `sb-<project-ref>-auth-token`
 * (see src/integrations/supabase/client.ts, which does not set storageKey). */
export function localSupabaseAuthStorageKey(supabaseUrl: string | undefined | null): string | null {
  const projectRef = supabaseUrl?.match(/https?:\/\/([^.]+)\./)?.[1];
  if (!projectRef) return null;
  return `sb-${projectRef}-auth-token`;
}

/**
 * Remove persisted Supabase auth keys for the LOCAL PesoWise project only.
 * Never touches any other Supabase client's storage on this origin (e.g. the
 * Cloud maintenance client's "pw-maintenance-cloud-auth" key) — matching is
 * an exact key match, or a match on `${expectedKey}-` as a prefix (for any
 * auxiliary per-session keys supabase-js may store alongside the main token,
 * e.g. a PKCE code verifier), never a broad "starts with sb-" or "contains
 * auth" pattern.
 */
export function clearLocalAuthStorage(): void {
  if (typeof window === "undefined") return;

  const expectedKey = localSupabaseAuthStorageKey(
    import.meta.env.VITE_SUPABASE_URL as string | undefined,
  );
  if (!expectedKey) return;

  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key === expectedKey || key.startsWith(`${expectedKey}-`)) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}
