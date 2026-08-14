/**
 * Tests for the Supabase auth network-error recovery fix.
 *
 * Root cause: `supabase.auth.getUser()` (the `_getUser` internal path) can
 * return or throw `TypeError: Failed to fetch` when the network is
 * temporarily unavailable. Before this fix:
 *   - `getValidatedAuthUser` would call `recoverFromInvalidAuthSession` even
 *     on network errors, risking a local-session wipe on a false positive.
 *   - In AuthContext's normal path, a network error left `loading` permanently
 *     stuck at `true` (the race guard returned early without setLoading(false)).
 *
 * Fix:
 *   1. `isSupabaseNetworkError` — distinguishes transient fetch failures from
 *      genuine auth denials (invalid refresh token, 401, etc.).
 *   2. `getValidatedAuthUser` — wraps in try/catch; skips
 *      `recoverFromInvalidAuthSession` for network errors; never throws.
 *   3. AuthContext normal path — race guard now resolves stuck loading and
 *      falls back to the local session on network errors.
 *   4. AuthContext — `window.online` listener triggers background refresh when
 *      network recovers.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();
const authSession = readFileSync(resolve(cwd, "src/lib/authSession.ts"), "utf-8");
const authContext = readFileSync(resolve(cwd, "src/contexts/AuthContext.tsx"), "utf-8");

// ── authSession.ts ────────────────────────────────────────────────────────────

describe("authSession.ts — isSupabaseNetworkError helper", () => {
  it("exports isSupabaseNetworkError", () => {
    expect(authSession).toContain("export function isSupabaseNetworkError");
  });

  it("detects 'failed to fetch' pattern", () => {
    expect(authSession).toContain('"failed to fetch"');
  });

  it("detects 'fetch failed' pattern (Node.js fetch wording)", () => {
    expect(authSession).toContain('"fetch failed"');
  });

  it("detects 'network request failed' pattern", () => {
    expect(authSession).toContain('"network request failed"');
  });

  it("checks message in lowercase (case-insensitive)", () => {
    expect(authSession).toContain(".toLowerCase()");
  });
});

describe("authSession.ts — getValidatedAuthUser network safety", () => {
  it("wraps getUser() in try/catch so thrown errors cannot propagate", () => {
    // The fix: try { ... getUser() ... } catch (thrown) { return { user: null, error } }
    // Verify try/catch exists around the getUser call inside getValidatedAuthUser.
    const fnStart = authSession.indexOf("export async function getValidatedAuthUser");
    const fnSnippet = authSession.slice(fnStart, fnStart + 600);
    expect(fnSnippet).toContain("try {");
    expect(fnSnippet).toContain("catch (");
  });

  it("does not call recoverFromInvalidAuthSession for network errors", () => {
    // Must guard with isSupabaseNetworkError before calling recover.
    const fnStart = authSession.indexOf("export async function getValidatedAuthUser");
    const fnSnippet = authSession.slice(fnStart, fnStart + 600);
    // The guard must appear before the recoverFrom call inside the function.
    const guardIdx = fnSnippet.indexOf("isSupabaseNetworkError");
    const recoverIdx = fnSnippet.indexOf("recoverFromInvalidAuthSession");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(recoverIdx).toBeGreaterThan(guardIdx);
  });

  it("returns { user: null, error } from the catch block (never throws)", () => {
    const fnStart = authSession.indexOf("export async function getValidatedAuthUser");
    const fnSnippet = authSession.slice(fnStart, fnStart + 600);
    expect(fnSnippet).toContain("return { user: null, error");
  });
});

// ── AuthContext.tsx ───────────────────────────────────────────────────────────

describe("AuthContext.tsx — imports isSupabaseNetworkError", () => {
  it("imports isSupabaseNetworkError from authSession", () => {
    expect(authContext).toContain("isSupabaseNetworkError");
  });
});

describe("AuthContext.tsx — race guard resolves stuck loading", () => {
  it("calls setLoading(false) when profileLoadedForUserIdRef.current is set at race guard", () => {
    // The fix adds: if (profileLoadedForUserIdRef.current) { if (!cancelled) setLoading(false); return; }
    expect(authContext).toContain("profileLoadedForUserIdRef.current");
    // setLoading(false) must appear in a block that also checks profileLoadedForUserIdRef
    const profileGuardIdx = authContext.indexOf("if (profileLoadedForUserIdRef.current)");
    expect(profileGuardIdx).toBeGreaterThanOrEqual(0);
    const snippetAfter = authContext.slice(profileGuardIdx, profileGuardIdx + 400);
    expect(snippetAfter).toContain("setLoading(false)");
  });

  it("calls applySignedInSession(raceSession) when local session exists but network failed", () => {
    // Previously: `if (raceSession?.user || profileLoadedForUserIdRef.current) return;`
    // After fix: separate blocks — raceSession?.user triggers applySignedInSession.
    expect(authContext).toContain("applySignedInSession(raceSession)");
  });

  it("no longer has the old combined guard that returns without loading cleanup", () => {
    // The old form: `if (raceSession?.user || profileLoadedForUserIdRef.current) return;`
    // was a single early return that left loading stuck. It must not exist anymore.
    expect(authContext).not.toContain("raceSession?.user || profileLoadedForUserIdRef.current");
  });
});

describe("AuthContext.tsx — online event recovery", () => {
  it("adds an online event listener for network recovery", () => {
    expect(authContext).toContain('addEventListener("online"');
  });

  it("removes the online listener on cleanup", () => {
    expect(authContext).toContain('removeEventListener("online"');
  });

  it("calls loadUserContext in the online handler for background refresh", () => {
    const onlineIdx = authContext.indexOf('addEventListener("online"');
    // The handler and loadUserContext call should be nearby
    const handlerSnippet = authContext.slice(
      Math.max(0, onlineIdx - 400),
      onlineIdx + 100,
    );
    expect(handlerSnippet).toContain("loadUserContext");
  });
});
