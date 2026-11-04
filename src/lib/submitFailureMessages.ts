/**
 * User-facing wording for a failed Submit (DOC-148). Never exposes raw database text and
 * always says whether a draft was preserved, so nobody has to guess and re-enter.
 */

const PRESERVED = "Your draft was preserved. Fix any highlighted fields and press Submit again - it will reuse the same expense.";

function rawOf(err: unknown): { raw: string; code: string; status: number | null } {
  const obj = err && typeof err === "object" ? (err as { message?: unknown; code?: unknown; status?: unknown }) : null;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : typeof obj?.message === "string" ? obj.message : "";
  const code = typeof obj?.code === "string" ? obj.code : "";
  const status = typeof obj?.status === "number" ? obj.status : null;
  return { raw: message.toLowerCase(), code, status };
}

/**
 * The request never produced an HTTP answer: the browser failed the fetch itself (Chromium "Failed to
 * fetch", Safari/iOS "Load failed", Firefox "NetworkError ...", a dropped keep-alive connection after the
 * camera or app switch). The server may or may not have seen it, so the outcome is UNKNOWN.
 *
 * Deliberately narrow: a PostgREST/Postgres error (it carries a SQLSTATE or PGRST code), an HTTP status, a
 * validation message or a bill error is NEVER a connection drop.
 */
export function isConnectionDropError(err: unknown): boolean {
  const { raw, code, status } = rawOf(err);
  if (status !== null && status >= 100) return false;
  if (/^([0-9a-z]{5}|pgrst\d+|pw\d+)$/i.test(code)) return false;
  return /failed to fetch|load failed|networkerror|network request failed|network connection was lost|failed to send a request to the edge function|econnreset|err_network|err_connection|the internet connection appears to be offline/.test(raw);
}

/**
 * The server DID answer but could not finish in time: PostgREST 57014 (statement timeout, the whole
 * statement is rolled back), or a gateway 502/503/504 (the upstream may still complete). Shown as a slow
 * server, NOT as a dropped connection.
 */
export function isServerSlowError(err: unknown): boolean {
  const { raw, code, status } = rawOf(err);
  if (code === "57014" || code === "55P03") return true;
  if (status === 502 || status === 503 || status === 504) return true;
  return /statement timeout|canceling statement|lock timeout|gateway time-?out|upstream server is timing out|temporarily unavailable|service unavailable|bad gateway/.test(raw);
}

/** True when the outcome of the request is unknown and the logical submission can be safely re-checked. */
export function isUnknownOutcomeError(err: unknown): boolean {
  return isConnectionDropError(err) || isServerSlowError(err);
}

/** Returns a plain sentence for failures we can classify, or null to let the caller fall through. */
export function friendlySubmitFailureMessage(
  err: unknown,
  opts: { draftPreserved: boolean },
): string | null {
  const obj = err && typeof err === "object" ? (err as { message?: unknown; code?: unknown }) : null;
  const raw = [
    err instanceof Error ? err.message : typeof err === "string" ? err : typeof obj?.message === "string" ? obj.message : "",
    typeof obj?.code === "string" ? obj.code : "",
  ].join(" ").toLowerCase();
  const tail = opts.draftPreserved ? ` ${PRESERVED}` : "";

  if (/jwt|not authenticated|invalid refresh token|session (has )?expired|session_not_found|session from session_id|refresh_token_not_found|28000|pgrst30[0-9]/.test(raw)) {
    return `Your session expired. Please sign in again and retry.${tail}`;
  }
  if (isServerSlowError(err)) {
    return `The server took too long to respond. Nothing is lost.${tail || " Please try again in a moment."}`;
  }
  if (isConnectionDropError(err)) {
    return `The connection dropped while submitting. Nothing is lost.${tail || " Check your connection and try again."}`;
  }
  if (/required additional field|required fields? (are|is) missing/.test(raw)) {
    return `Some required fields are missing.${tail}`;
  }
  if (/still a draft after submitting/.test(raw)) {
    return `The expense could not be submitted.${tail}`;
  }
  return null;
}
