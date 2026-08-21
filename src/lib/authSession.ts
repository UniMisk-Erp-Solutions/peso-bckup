import { supabase } from "@/integrations/supabase/client";
import { clearLocalAuthStorage } from "@/lib/localAuthStorageKey";

export { clearLocalAuthStorage } from "@/lib/localAuthStorageKey";

const REFRESH_TOKEN_ERROR_PATTERN = /refresh token/i;

const NETWORK_ERROR_PHRASES = [
  "failed to fetch",
  "fetch failed",
  "network request failed",
  "networkerror",
  "load failed",
  "connection refused",
  "etimedout",
  "econnrefused",
];

export function isInvalidRefreshTokenError(message?: string | null): boolean {
  if (!message) return false;
  return REFRESH_TOKEN_ERROR_PATTERN.test(message);
}

/** Returns true when the error is a transient network/fetch failure (not an auth denial). */
export function isSupabaseNetworkError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return NETWORK_ERROR_PHRASES.some((p) => msg.includes(p));
}

type AuthErrorLike =
  | string
  | { message?: string | null; status?: number; name?: string; code?: string }
  | null
  | undefined;

function authErrorMessage(error: AuthErrorLike): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  return error.message ?? null;
}

/**
 * True when an error represents an actually-invalid auth session: an
 * expired/invalid refresh token message, OR a generic Supabase `AuthApiError`
 * carrying `status: 401` (e.g. a bare "Unauthorized" with no refresh-token
 * wording — exactly what a stale/invalid session produces on ordinary
 * authenticated requests once the token itself no longer validates).
 *
 * Network failures (Failed to fetch, timeouts, 503, offline) are excluded
 * first and always win — those are transient and must never be treated as
 * an invalid session.
 */
export function isInvalidAuthSessionError(error: AuthErrorLike): boolean {
  const message = authErrorMessage(error);
  if (isSupabaseNetworkError(message ?? error)) return false;
  if (isInvalidRefreshTokenError(message)) return true;

  if (typeof error === "object" && error) {
    const { status, name } = error;
    if (status === 401 && (name === "AuthApiError" || name === "AuthError")) {
      return true;
    }
  }
  return false;
}

/**
 * Fired once per invalid-refresh-token recovery so exactly one "session expired"
 * message reaches the user. Supabase can surface the same failure repeatedly
 * (getUser + TOKEN_REFRESHED + each in-flight query), and without a latch that
 * became a toast storm and a stream of duplicate GlitchTip events.
 */
export const SESSION_EXPIRED_EVENT = "pesowise:session-expired";

let sessionExpiredHandled = false;

/** Test seam — resets the one-shot latch. */
export function resetSessionExpiredNotice(): void {
  sessionExpiredHandled = false;
}

/** True when a session-expired recovery has already been handled in this page load. */
export function wasSessionExpiredHandled(): boolean {
  return sessionExpiredHandled;
}

/**
 * Drop invalid persisted sessions so fresh sign-in can succeed.
 *
 * Deliberately does NOT navigate: the caller stays wherever it is and React Router
 * renders /auth on the SAME origin. Sending the browser to an absolute URL here is
 * what used to move tenant users to the apex.
 */
export async function recoverFromInvalidAuthSession(error?: AuthErrorLike): Promise<void> {
  // isInvalidAuthSessionError excludes transient network failures first (a
  // "Failed to fetch" must never reach this path — clearing storage would
  // sign out a perfectly valid user) and otherwise recognizes both a
  // refresh-token message and a bare AuthApiError 401 as truly invalid.
  if (!isInvalidAuthSessionError(error)) return;

  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;

  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // ignore — we'll still clear storage below
  }
  clearLocalAuthStorage();

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
}

/** Validate session with Supabase; clears stale local tokens when refresh fails.
 * Network errors are returned as `{ user: null, error }` without clearing the session. */
export async function getValidatedAuthUser() {
  try {
    const { data, error } = await supabase.auth.getUser();

    if (error) {
      // Only attempt recovery for real auth failures, not transient network errors.
      if (!isSupabaseNetworkError(error)) {
        await recoverFromInvalidAuthSession(error);
      }
      return { user: null, error };
    }

    return { user: data.user, error: null };
  } catch (thrown) {
    // supabase.auth.getUser() can throw on hard network failures.
    // Never clear the session for a thrown fetch error.
    const err = thrown instanceof Error ? thrown : new Error(String(thrown));
    return { user: null, error: err };
  }
}

/** Run before React mounts so stale refresh tokens cannot block the app. */
export async function bootstrapAuthSession(): Promise<void> {
  if (typeof window === "undefined") return;

  try {
    const { error } = await supabase.auth.getUser();
    if (error) {
      await recoverFromInvalidAuthSession(error);
    }
  } catch (err) {
    // Only clear local auth storage when we can confirm the token is invalid/corrupt.
    // Network errors (503, fetch failure, timeout) must NOT clear the token — the user
    // may simply be offline or the backend temporarily unreachable.
    const errLike = err instanceof Error ? err : new Error(String(err));
    if (isInvalidAuthSessionError(errLike)) {
      clearLocalAuthStorage();
    }
    // All other errors (network, abort, timeout) → leave storage intact.
  }
}

/** Call before password sign-in to avoid corrupted refresh-token state blocking login. */
export async function prepareForPasswordSignIn(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // no-op
  }
  clearLocalAuthStorage();
}

/** Map Supabase auth errors to user-friendly sign-in messages. */
export function formatAuthErrorMessage(error: {
  message?: string;
  status?: number;
  code?: string;
}): string {
  const msg = (error.message ?? "").trim();
  const code = (error.code ?? "").toLowerCase();

  if (isInvalidRefreshTokenError(msg)) {
    return "Your session expired. Please sign in again.";
  }
  if (
    code === "invalid_credentials" ||
    /invalid login credentials/i.test(msg) ||
    /invalid email or password/i.test(msg)
  ) {
    return "Incorrect email or password. Check your credentials and try again.";
  }
  if (code === "email_not_confirmed" || /email not confirmed/i.test(msg)) {
    return "Please confirm your email before signing in.";
  }
  if (/user banned|user disabled/i.test(msg)) {
    return "This account is disabled. Contact your administrator.";
  }
  if (/rate limit|too many requests/i.test(msg)) {
    return "Too many sign-in attempts. Wait a minute and try again.";
  }
  if (/captcha|turnstile|challenge/i.test(msg)) {
    return "Security verification is required. Complete the CAPTCHA below and try again.";
  }
  if (/captcha|turnstile|challenge/i.test(msg)) {
    return "Security verification is required. Complete the CAPTCHA below and try again.";
  }
  if (error.status === 400 && !msg) {
    return "Sign-in failed. Clear site data for this page and try again, or contact support.";
  }

  return msg || "Sign-in failed. Please try again.";
}
