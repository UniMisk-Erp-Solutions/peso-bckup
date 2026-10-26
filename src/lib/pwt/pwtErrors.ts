/**
 * One place that turns any failure of the Tally features into a short, plain sentence that says WHAT went wrong and WHAT to do:
 * no internet, expired login, no permission, the server too busy or too slow, a sync that is too large, the Tally PC offline,
 * a missing database setup, and so on. Raw technical text (stack traces, SQL messages, "non-2xx") is never shown on its own.
 */

export type PwtErrorKind =
  | "network" | "session" | "permission" | "not_paired" | "bad_code" | "too_large" | "timeout" | "rate_limit" | "server_setup"
  | "tally_offline" | "tally_company" | "conflict" | "server" | "unknown";

interface Rule { kind: PwtErrorKind; test: RegExp; text: string }

// Order matters: the first rule that matches wins.
const RULES: Rule[] = [
  { kind: "network", test: /failed to fetch|networkerror|network request failed|load failed|failed to send a request|err_internet|err_network|err_connection|econnreset|enotfound|fetch failed/i,
    text: "Cannot reach the PesoWise server. Check your internet connection and try again." },
  { kind: "not_paired", test: /no tally connector is paired/i,
    text: "No Tally connector is paired for this organisation. Pair one on the Tally setup page and keep that company open in TallyPrime." },
  { kind: "bad_code", test: /invalid or expired pairing code/i,
    text: "That pairing code is wrong or has expired (codes last 15 minutes). Get a new code on the Tally setup page and try again." },
  { kind: "session", test: /jwt expired|invalid jwt|jwt is expired|not authenticated|session (has )?expired|refresh token|auth session missing|\b401\b|unauthorized/i,
    text: "Your login has expired. Please sign in again and retry." },
  { kind: "permission", test: /not permitted|forbidden|\b403\b|42501|permission denied|row-level security|only an admin/i,
    text: "You do not have permission for this. Only an administrator can use Tally sync." },
  { kind: "too_large", test: /statement timeout|57014|canceling statement/i,
    text: "This sync is too large for the server to prepare in one go. Choose a shorter period (for example one month) and sync again." },
  { kind: "server_setup", test: /schema cache|could not find the function|pgrst20\d|relation .* does not exist|function .* does not exist|undefined_table|42883|42p01/i,
    text: "The Tally part of the server is not fully set up yet. Ask the administrator to finish the database update, then try again." },
  { kind: "rate_limit", test: /\b429\b|too many requests|rate limit/i,
    text: "Too many requests in a short time. Wait a minute and try again." },
  { kind: "timeout", test: /timed out|time-?out|\b504\b|gateway time|aborterror|aborted/i,
    text: "The server did not answer in time. Wait a minute and try again." },
  { kind: "tally_offline", test: /tally_offline|tallyprime is not running|cannot reach tallyprime|econnrefused|connector .* offline|is offline/i,
    text: "TallyPrime cannot be reached on the Tally PC. Open TallyPrime, open the paired company and keep the Tally port on (F1, Settings, Connectivity), then try again." },
  { kind: "tally_company", test: /active (tally )?company|not the paired company|company mismatch|authorised company/i,
    text: "The company open in TallyPrime is not the one paired with PesoWise. Open the paired company and try again." },
  { kind: "conflict", test: /already exists in tally with different amounts|duplicate voucher|23505|duplicate key/i,
    text: "A voucher with the same number already exists in Tally with different amounts. Check it in Tally before syncing again." },
  { kind: "server", test: /non-2xx|\b50[0-3]\b|internal server error|bad gateway|service unavailable|server misconfiguration|edge function/i,
    text: "The server had a problem. This is usually temporary: try again in a minute. If it keeps happening, tell the administrator." },
];

function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; error?: unknown; code?: unknown; details?: unknown };
    const parts = [o.message, o.error, o.code, o.details].filter((x) => typeof x === "string" || typeof x === "number").map(String);
    if (parts.length) return parts.join(" ");
  }
  return "";
}

export function classifyPwtError(e: unknown): PwtErrorKind {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "network";
  const m = messageOf(e);
  return RULES.find((r) => r.test.test(m))?.kind ?? "unknown";
}

/** A short sentence for the person using the screen. `fallback` is used only when nothing is known about the failure. */
export function describePwtError(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return RULES[0].text;
  const m = messageOf(e);
  const hit = RULES.find((r) => r.test.test(m));
  if (hit) return hit.text;
  // A clear sentence the server wrote itself (for example "the voucher type name is required") is better than a generic one.
  const plain = m.trim();
  if (plain && plain.length <= 160 && !/[{}<>]|\bat \S+:\d+|\n/.test(plain) && /[a-z]{3}/i.test(plain)) return plain;
  return fallback;
}

/** The text of a failed edge-function call: the server's own explanation when it gave one, otherwise a status-based sentence. */
export async function functionErrorText(error: { message?: string; context?: unknown }): Promise<string> {
  const res = error.context as (Response & { status?: number }) | undefined;
  let serverText = "";
  try {
    if (res && typeof res.json === "function") {
      const body = (await res.json()) as { error?: string; message?: string };
      serverText = body?.error ?? body?.message ?? "";
    }
  } catch { /* no readable body */ }
  if (serverText) {
    const said = describePwtError(serverText, "");
    if (said) return said;
  }
  const status = typeof res?.status === "number" ? res.status : undefined;
  return describePwtError(`${status ? `HTTP ${status} ` : ""}${error.message ?? ""}`, "The server could not complete the request. Try again.");
}
