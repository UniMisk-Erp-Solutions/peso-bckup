/** When true, UI should block mutating actions (recovery Supabase only). */
export function isRecoveryMode(): boolean {
  return import.meta.env.VITE_RECOVERY_MODE === "true";
}

export const RECOVERY_BANNER =
  "RECOVERY ENVIRONMENT — READ ONLY. Do not use for live operations.";
