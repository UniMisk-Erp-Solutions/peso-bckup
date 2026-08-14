/**
 * Behavioral coverage for the 401-classification gap identified while
 * debugging the GlitchTip "Unauthorized" burst (debug/6456-supervisor-auth-runtime).
 *
 * Before this change, `isInvalidRefreshTokenError` only matched messages
 * containing "refresh token" — a bare Supabase `AuthApiError` with
 * `status: 401` and message "Unauthorized" (exactly what GlitchTip showed for
 * the balance/org-settings/tenant-RPC calls) was never classified as an
 * invalid session, so no recovery ever ran for it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  isInvalidAuthSessionError,
  isInvalidRefreshTokenError,
  isSupabaseNetworkError,
  recoverFromInvalidAuthSession,
  resetSessionExpiredNotice,
  wasSessionExpiredHandled,
} from "@/lib/authSession";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));

describe("isInvalidAuthSessionError", () => {
  it("classifies a bare AuthApiError 401 'Unauthorized' as invalid — the exact incident shape", () => {
    const err = { name: "AuthApiError", status: 401, message: "Unauthorized" };
    expect(isInvalidAuthSessionError(err)).toBe(true);
  });

  it("still classifies a refresh-token message as invalid", () => {
    expect(
      isInvalidAuthSessionError("Invalid Refresh Token: Refresh Token Not Found"),
    ).toBe(true);
  });

  it("does NOT classify a network failure as invalid, even with auth-shaped fields", () => {
    expect(isInvalidAuthSessionError("Failed to fetch")).toBe(false);
    expect(isInvalidAuthSessionError(new Error("NetworkError when attempting to fetch"))).toBe(
      false,
    );
  });

  it("does NOT classify a 401 with a non-auth error name (defensive: don't over-trigger)", () => {
    expect(isInvalidAuthSessionError({ name: "PostgrestError", status: 401, message: "denied" })).toBe(
      false,
    );
  });

  it("does NOT classify a 403/500 AuthApiError as an invalid session", () => {
    expect(isInvalidAuthSessionError({ name: "AuthApiError", status: 403, message: "Forbidden" })).toBe(
      false,
    );
    expect(
      isInvalidAuthSessionError({ name: "AuthApiError", status: 500, message: "Internal" }),
    ).toBe(false);
  });

  it("does NOT classify a timeout/503 as invalid", () => {
    expect(isInvalidAuthSessionError("timeout of 8000ms exceeded")).toBe(false);
    expect(isInvalidAuthSessionError({ name: "AuthApiError", status: 503, message: "unavailable" })).toBe(
      false,
    );
  });

  it("handles null/undefined without throwing", () => {
    expect(isInvalidAuthSessionError(null)).toBe(false);
    expect(isInvalidAuthSessionError(undefined)).toBe(false);
  });

  it("agrees with the existing narrower helpers on their own cases", () => {
    expect(isInvalidRefreshTokenError("Failed to fetch")).toBe(false);
    expect(isSupabaseNetworkError(new Error("Failed to fetch"))).toBe(true);
  });
});

describe("recoverFromInvalidAuthSession — now reachable from a bare 401", () => {
  beforeEach(async () => {
    resetSessionExpiredNotice();
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.auth.signOut as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    resetSessionExpiredNotice();
  });

  it("signs out and latches on a bare AuthApiError 401", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const signOut = supabase.auth.signOut as ReturnType<typeof vi.fn>;

    await recoverFromInvalidAuthSession({
      name: "AuthApiError",
      status: 401,
      message: "Unauthorized",
    });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(wasSessionExpiredHandled()).toBe(true);
  });

  it("a second bare-401 in the same page load does not sign out again (one-shot latch holds)", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const signOut = supabase.auth.signOut as ReturnType<typeof vi.fn>;

    await recoverFromInvalidAuthSession({ name: "AuthApiError", status: 401, message: "Unauthorized" });
    await recoverFromInvalidAuthSession({ name: "AuthApiError", status: 401, message: "Unauthorized" });
    await recoverFromInvalidAuthSession({ name: "AuthApiError", status: 401, message: "Unauthorized" });

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("still never signs out for a network failure", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const signOut = supabase.auth.signOut as ReturnType<typeof vi.fn>;

    await recoverFromInvalidAuthSession("Failed to fetch");

    expect(signOut).not.toHaveBeenCalled();
    expect(wasSessionExpiredHandled()).toBe(false);
  });
});
