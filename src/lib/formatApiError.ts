/** Human-readable message from Supabase/PostgREST errors, fetch failures, etc. */
export function formatApiError(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) return error.message || fallback;
  if (error && typeof error === "object") {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
    const details = (error as { details?: unknown }).details;
    if (typeof details === "string" && details.trim()) return details;
    const hint = (error as { hint?: unknown }).hint;
    if (typeof hint === "string" && hint.trim()) return hint;
  }
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}
