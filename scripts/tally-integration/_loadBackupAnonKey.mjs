/** Resolve publishable anon JWT for pesowise-backup-supabase (Vercel bundle or env). */
export async function loadBackupAnonKey() {
  if (process.env.TALLY_VALIDATE_ANON_KEY) return process.env.TALLY_VALIDATE_ANON_KEY;
  if (process.env.PESO_TALLY_ANON_KEY) return process.env.PESO_TALLY_ANON_KEY;
  const t = await fetch("https://peso-backup.vercel.app/assets/index-Di3_NMzi.js").then((r) => r.text());
  const m = t.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!m) throw new Error("Set TALLY_VALIDATE_ANON_KEY or PESO_TALLY_ANON_KEY");
  return m[0];
}
