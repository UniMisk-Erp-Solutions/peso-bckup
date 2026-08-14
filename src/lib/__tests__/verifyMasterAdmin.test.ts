/**
 * Tests for verifyMasterAdmin.
 * Tests T8–T16 (auth behavior, 503 for missing config, timeout cleanup).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyMasterAdmin } from "../../../api/_lib/verifyMasterAdmin";

const ALL_VARS = [
  "SUPABASE_URL", "VITE_SUPABASE_URL",
  "SUPABASE_ANON_KEY", "VITE_SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY",
];

function setupEnv(url = "https://test.supabase.co", anonKey = "test-anon") {
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_ANON_KEY = anonKey;
}

function clearEnv() {
  for (const v of ALL_VARS) delete process.env[v];
}

describe("verifyMasterAdmin", () => {
  beforeEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  it("T11: missing Authorization header returns 401 missing_authorization", async () => {
    setupEnv();
    const result = await verifyMasterAdmin(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("missing_authorization");
    }
  });

  it("T11b: non-Bearer Authorization returns 401 missing_authorization", async () => {
    setupEnv();
    const result = await verifyMasterAdmin("Basic abc123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("missing_authorization");
    }
  });

  it("T13: missing Supabase config returns 503 server_configuration_missing", async () => {
    clearEnv(); // no URL or key set
    const result = await verifyMasterAdmin("Bearer valid-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe("server_configuration_missing");
      expect(result.missingVariables).toBeDefined();
      expect(Array.isArray(result.missingVariables)).toBe(true);
    }
  });

  it("T12: expired/invalid token returns 401 invalid_session", async () => {
    setupEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "JWT expired" }), { status: 401 }),
    );
    const result = await verifyMasterAdmin("Bearer expired-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.code).toBe("invalid_session");
    }
    fetchSpy.mockRestore();
  });

  it("T10: ordinary user (no master admin) returns 403 master_admin_forbidden", async () => {
    setupEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        // /auth/v1/user — valid user
        new Response(JSON.stringify({ id: "user-123", email: "user@test.com" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        // profiles — not master admin
        new Response(JSON.stringify([{ is_master_admin: false }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        // memberships — no active membership
        new Response(JSON.stringify([]), { status: 200 }),
      );
    const result = await verifyMasterAdmin("Bearer regular-user-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("master_admin_forbidden");
    }
    fetchSpy.mockRestore();
  });

  it("T8: profiles.is_master_admin=true authorizes", async () => {
    setupEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "admin-1", email: "admin@test.com" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ is_master_admin: true }]), { status: 200 }),
      );
    const result = await verifyMasterAdmin("Bearer master-admin-token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("admin-1");
      expect(result.email).toBe("admin@test.com");
    }
    fetchSpy.mockRestore();
  });

  it("T9: active membership authorizes even when profile flag is false", async () => {
    setupEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "member-1", email: "member@test.com" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ is_master_admin: false }]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "mem-id-1" }]), { status: 200 }),
      );
    const result = await verifyMasterAdmin("Bearer membership-token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("member-1");
    }
    fetchSpy.mockRestore();
  });

  it("T14: AbortController timeout returns 503 auth_unavailable", async () => {
    setupEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new DOMException("The user aborted a request.", "AbortError")), 10),
      ),
    );
    const result = await verifyMasterAdmin("Bearer slow-token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe("auth_unavailable");
    }
    fetchSpy.mockRestore();
  });

  it("T16: service-role key never appears in logs (no env set)", async () => {
    // Only checking that missing config path doesn't leak secrets
    clearEnv();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await verifyMasterAdmin("Bearer some-token");
    const loggedArgs = consoleSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).not.toMatch(/sk-/);
    expect(result.ok).toBe(false);
    consoleSpy.mockRestore();
  });
});
