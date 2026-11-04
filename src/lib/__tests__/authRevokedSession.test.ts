/**
 * Console audit 2026-10-16 -- GET /auth/v1/user 403.
 *
 * Production GoTrue logs show 403 `session_not_found` on /user and /logout and 400
 * `refresh_token_not_found` on /token: the SERVER no longer has the session (a global sign-out from
 * another device, a revoked session, a deactivated user). The access token still looks valid until
 * it expires, so the client kept calling /auth/v1/user with it. Before this fix the 403 was NOT
 * classified as an invalid session, so no recovery ever ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.fn().mockResolvedValue({ error: null });
const getUser = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signOut: (...a: unknown[]) => signOut(...a), getUser: (...a: unknown[]) => getUser(...a) } },
}));

import {
  getValidatedAuthUser,
  isInvalidAuthSessionError,
  recoverFromInvalidAuthSession,
  resetSessionExpiredNotice,
  SESSION_EXPIRED_EVENT,
} from "@/lib/authSession";

const revoked = { name: "AuthApiError", status: 403, code: "session_not_found", message: "Session from session_id claim in JWT does not exist" };

beforeEach(() => {
  signOut.mockClear();
  getUser.mockReset();
  resetSessionExpiredNotice();
});

describe("classification", () => {
  it("403 session_not_found (the exact production shape) is an invalid session", () => {
    expect(isInvalidAuthSessionError(revoked)).toBe(true);
  });
  it("the same failure without a code is still recognised by its message", () => {
    expect(isInvalidAuthSessionError({ name: "AuthApiError", status: 403, message: "Session from session_id claim in JWT does not exist" })).toBe(true);
  });
  it("400 refresh_token_not_found and refresh_token_already_used are invalid sessions", () => {
    expect(isInvalidAuthSessionError({ name: "AuthApiError", status: 400, code: "refresh_token_not_found", message: "x" })).toBe(true);
    expect(isInvalidAuthSessionError({ name: "AuthApiError", status: 400, code: "refresh_token_already_used", message: "x" })).toBe(true);
  });
  it("a network failure or an unrelated 403 never counts (they must not sign a valid user out)", () => {
    expect(isInvalidAuthSessionError(new Error("Failed to fetch"))).toBe(false);
    expect(isInvalidAuthSessionError({ name: "AuthApiError", status: 403, code: "not_admin", message: "User not allowed" })).toBe(false);
    expect(isInvalidAuthSessionError({ name: "AuthApiError", status: 500, message: "unable to fetch records: timeout" })).toBe(false);
  });
});

describe("recovery: one attempt, clean sign-out, no loop", () => {
  it("valid session: no recovery, no sign-out", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "u" } }, error: null });
    const r = await getValidatedAuthUser();
    expect(r.user).toEqual({ id: "u" });
    expect(signOut).not.toHaveBeenCalled();
  });

  it("revoked session: ONE local sign-out and ONE session-expired event, however many callers hit the 403", async () => {
    const events: string[] = [];
    window.addEventListener(SESSION_EXPIRED_EVENT, () => events.push("expired"));
    getUser.mockResolvedValue({ data: { user: null }, error: revoked });
    const results = await Promise.all([getValidatedAuthUser(), getValidatedAuthUser(), getValidatedAuthUser(), getValidatedAuthUser()]);
    expect(results.every((r) => r.user === null)).toBe(true);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" }); // never a network /logout against a dead session
    expect(events).toHaveLength(1);
  });

  it("a transient network failure leaves the session alone", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: new Error("Failed to fetch") });
    await getValidatedAuthUser();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("recoverFromInvalidAuthSession ignores errors that are not an invalid session", async () => {
    await recoverFromInvalidAuthSession({ name: "AuthApiError", status: 403, code: "not_admin", message: "nope" });
    expect(signOut).not.toHaveBeenCalled();
  });
});

import { readFileSync } from "fs";
import { resolve } from "path";

describe("explicit Sign out (AuthContext) - source guards", () => {
  const src = readFileSync(resolve(process.cwd(), "src/contexts/AuthContext.tsx"), "utf-8").replace(/\r\n/g, "\n");
  it("signs out THIS device only; the global default would end every other device's session (153 production users have several)", () => {
    expect(src).toContain('supabase.auth.signOut({ scope: "local" })');
    expect(src).not.toMatch(/supabase\.auth\.signOut\(\)/);
  });
  it("is single-flight, so five rapid clicks cannot send five /logout requests", () => {
    expect(src).toContain("let signOutInFlight: Promise<void> | null = null;");
    expect(src).toContain("if (!signOutInFlight) {");
    expect(src).toContain("await signOutInFlight;");
  });
  it("always clears this origin's local auth keys, even if the network call fails", () => {
    expect(src).toMatch(/finally \{\n\s+clearLocalAuthStorage\(\);/);
  });
});
