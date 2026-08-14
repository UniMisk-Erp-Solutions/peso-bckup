/**
 * Wrong-tenant signout ordering (debug/6456-supervisor-auth-runtime, §24-25).
 *
 * Confirmed root cause of the GlitchTip "get_tenant_sign_in_subdomain_for_user:
 * Unauthorized" burst: `rejectWrongTenantSession` used to call `signOut()`
 * BEFORE `redirectToUserTenantSignIn`, and that function's own RPC lookup is
 * RLS-scoped — calling it after signOut reliably fails with Unauthorized,
 * which then made `redirectToUserTenantSignIn` treat the lookup as
 * "unresolved" and strand the user on the WRONG tenant's own /auth instead of
 * redirecting them to their real one.
 *
 * These tests exercise the real functions end-to-end (mocking only the
 * Supabase client and window.location), not source regexes, because the bug
 * was specifically about *runtime call order*, which text matching cannot see.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { rejectWrongTenantSession } from "@/lib/tenantAccess";
import { TenantRedirectingError } from "@/lib/tenantRedirect";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

/** Replaces window.location for the duration of a test. */
function setLocation(href: string): { replace: ReturnType<typeof vi.fn> } {
  const url = new URL(href);
  const replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: url.href,
      origin: url.origin,
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname,
      search: url.search,
      replace,
      assign: vi.fn(),
    },
  });
  return { replace };
}

describe("rejectWrongTenantSession — resolve before signout", () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it("calls the tenant-lookup RPC BEFORE signOut, never after", async () => {
    setLocation("https://ml.pesowise.unimisk.com/expenses/batch/new");

    const callOrder: string[] = [];
    rpcMock.mockImplementation(async (fn: string) => {
      callOrder.push(`rpc:${fn}`);
      if (fn === "get_tenant_sign_in_subdomain_for_user") {
        return { data: "other-tenant", error: null };
      }
      return { data: null, error: null };
    });
    const signOut = vi.fn().mockImplementation(async () => {
      callOrder.push("signOut");
    });

    await expect(
      rejectWrongTenantSession({ userId: "user-1", signOut }),
    ).rejects.toBeInstanceOf(TenantRedirectingError);

    expect(callOrder).toEqual(["rpc:get_tenant_sign_in_subdomain_for_user", "signOut"]);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("navigates to the resolved tenant's /auth using the value looked up BEFORE signout", async () => {
    const { replace } = setLocation("https://ml.pesowise.unimisk.com/expenses/batch/new");
    rpcMock.mockResolvedValue({ data: "other-tenant", error: null });
    const signOut = vi.fn().mockResolvedValue(undefined);

    await expect(
      rejectWrongTenantSession({ userId: "user-1", signOut }),
    ).rejects.toBeInstanceOf(TenantRedirectingError);

    expect(replace).toHaveBeenCalledTimes(1);
    const [url] = replace.mock.calls[0] as [string];
    expect(url).toContain("other-tenant.pesowise.unimisk.com/auth");
    expect(url).toContain("from_wrong_tenant=1");
  });

  it("if the RPC would fail (as it does post-signout today without this fix), it is never given the chance — signOut runs strictly after", async () => {
    setLocation("https://ml.pesowise.unimisk.com/expenses/batch/new");

    let signedOut = false;
    rpcMock.mockImplementation(async () => {
      // Simulates the RLS-scoped RPC: if this ever ran after signOut, it
      // would return Unauthorized. Asserting it never sees signedOut=true
      // is the direct regression test for the original bug.
      expect(signedOut).toBe(false);
      return { data: "other-tenant", error: null };
    });
    const signOut = vi.fn().mockImplementation(async () => {
      signedOut = true;
    });

    await expect(
      rejectWrongTenantSession({ userId: "user-1", signOut }),
    ).rejects.toBeInstanceOf(TenantRedirectingError);

    expect(signedOut).toBe(true); // signOut still happened, just after resolution
  });

  it("stays on the same origin (no cross-host redirect) when the tenant cannot be resolved, even post-signout", async () => {
    const { replace } = setLocation("https://ml.pesowise.unimisk.com/expenses/batch/new");
    // Simulates the RPC returning Unauthorized/null — must resolve to "stay",
    // never to the apex.
    rpcMock.mockResolvedValue({ data: null, error: { message: "Unauthorized" } });
    const signOut = vi.fn().mockResolvedValue(undefined);

    await expect(
      rejectWrongTenantSession({ userId: "user-1", signOut }),
    ).rejects.toBeInstanceOf(TenantRedirectingError);

    expect(replace).toHaveBeenCalledTimes(1);
    const [url] = replace.mock.calls[0] as [string];
    expect(url).toContain("ml.pesowise.unimisk.com"); // same origin, not apex
    expect(url).toContain("from_wrong_tenant=1");
  });
});
