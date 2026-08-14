/**
 * Canonical server-side Supabase configuration resolver.
 * The ONLY place that reads Supabase env vars on the server.
 * Server-only. Do NOT import into the Vite client bundle.
 *
 * Resolution order:
 *   URL:      SUPABASE_URL → VITE_SUPABASE_URL
 *   ANON KEY: SUPABASE_ANON_KEY → VITE_SUPABASE_ANON_KEY → VITE_SUPABASE_PUBLISHABLE_KEY
 *   SERVICE:  SUPABASE_SERVICE_ROLE_KEY  (no VITE fallback — server-only)
 *
 * Production recommendation: set dedicated server-side vars:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * VITE_* fallbacks are temporary compatibility support for Preview environments.
 *
 * Never expose variable values — only variable names in error output.
 */

export type SupabaseServerConfigResult =
  | {
      ok: true;
      url: string;
      anonKey: string;
      serviceRoleKey: string | null;
      sources: {
        url: "SUPABASE_URL" | "VITE_SUPABASE_URL";
        anonKey:
          | "SUPABASE_ANON_KEY"
          | "VITE_SUPABASE_ANON_KEY"
          | "VITE_SUPABASE_PUBLISHABLE_KEY";
      };
    }
  | {
      ok: false;
      missingVariables: string[];
    };

export function resolveSupabaseServerConfig(): SupabaseServerConfigResult {
  const missingVariables: string[] = [];

  // Resolve URL
  let url: string | undefined;
  let urlSource: "SUPABASE_URL" | "VITE_SUPABASE_URL" | undefined;
  if (process.env.SUPABASE_URL) {
    url = process.env.SUPABASE_URL.replace(/\/$/, "");
    urlSource = "SUPABASE_URL";
  } else if (process.env.VITE_SUPABASE_URL) {
    url = process.env.VITE_SUPABASE_URL.replace(/\/$/, "");
    urlSource = "VITE_SUPABASE_URL";
  } else {
    missingVariables.push("SUPABASE_URL");
  }

  // Resolve anon key
  let anonKey: string | undefined;
  let anonKeySource:
    | "SUPABASE_ANON_KEY"
    | "VITE_SUPABASE_ANON_KEY"
    | "VITE_SUPABASE_PUBLISHABLE_KEY"
    | undefined;
  if (process.env.SUPABASE_ANON_KEY) {
    anonKey = process.env.SUPABASE_ANON_KEY;
    anonKeySource = "SUPABASE_ANON_KEY";
  } else if (process.env.VITE_SUPABASE_ANON_KEY) {
    anonKey = process.env.VITE_SUPABASE_ANON_KEY;
    anonKeySource = "VITE_SUPABASE_ANON_KEY";
  } else if (process.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    anonKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    anonKeySource = "VITE_SUPABASE_PUBLISHABLE_KEY";
  } else {
    missingVariables.push("SUPABASE_ANON_KEY");
  }

  if (missingVariables.length > 0) {
    return { ok: false, missingVariables };
  }

  // Service role key is optional at resolution time; callers that require it check separately
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;

  return {
    ok: true,
    url: url!,
    anonKey: anonKey!,
    serviceRoleKey,
    sources: {
      url: urlSource!,
      anonKey: anonKeySource!,
    },
  };
}

/** Returns the list of missing variables required for privileged server-side operations. */
export function getMissingServiceRoleVars(): string[] {
  const missing: string[] = [];
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}
