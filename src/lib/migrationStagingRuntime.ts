/** True when the app should use the PesoWise HTTP API instead of Supabase client (staging or post-cutover production). */
export function isMigrationStagingBackend(): boolean {
  const api = import.meta.env.VITE_API_URL?.trim();
  if (!api) return false;
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
  if (!supabaseUrl) return true;
  return import.meta.env.VITE_MIGRATION_STAGING === "true";
}

export function migrationApiBaseUrl(): string {
  return (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
}

/** Production Supabase host patterns that must never appear in migration staging network traffic. */
export const FORBIDDEN_PRODUCTION_SUPABASE_HOST_MARKERS = [
  "pesowise-backup-supabase",
  "pesowise-supabase.unimisk.com",
  ":54321",
  "/auth/v1",
  "/rest/v1",
  "/storage/v1",
  "/realtime/v1",
  "/functions/v1",
] as const;
