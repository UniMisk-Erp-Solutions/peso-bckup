/** Dev-friendly check — publishable anon key is required for the app to boot. */
export function getSupabaseClientEnvError(): string | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key =
    import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url) {
    return "Missing VITE_SUPABASE_URL in .env.local (see .env.local.example).";
  }
  if (!key) {
    return "Missing VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) in .env.local. Copy the anon key from your Supabase/Coolify project or run scripts/local-dev-start.ps1 for local Docker Supabase.";
  }
  return null;
}
