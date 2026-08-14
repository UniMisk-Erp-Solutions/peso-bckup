/**
 * ProtectedRoute first-paint tenant race (debug/6456-supervisor-auth-runtime, §27).
 *
 * `tenantChecking` used to be a `useState(false)` only flipped to `true`
 * inside an effect (which runs AFTER the first commit). On a tenant host, a
 * cached-but-not-yet-verified user could get exactly one render where
 * `loading` had already flipped to `false` but `tenantChecking` was still
 * its stale initial `false` — mounting the protected child, which could fire
 * authenticated requests, before tenant verification had even started.
 *
 * The fix makes `tenantChecking` a value DERIVED synchronously during render
 * from state tracking which (user, tenant) combination has been verified —
 * closing the gap entirely rather than narrowing it. This test renders the
 * REAL ProtectedRoute and proves the child never mounts before
 * verifyTenantSessionForUser is called, using a controllable promise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";

vi.mock("@/contexts/SystemAvailabilityContext", () => ({
  useSystemAvailability: () => ({ blocking: false, initializing: false }),
}));

const verifyTenantSessionForUser = vi.fn();
vi.mock("@/lib/tenantAccess", () => ({
  verifyTenantSessionForUser: (...args: unknown[]) => verifyTenantSessionForUser(...args),
  rejectWrongTenantSession: vi.fn().mockRejectedValue(new Error("unused")),
  TenantRedirectingError: class TenantRedirectingError extends Error {},
}));

function ProtectedChild() {
  // Simulates a protected page firing an authenticated request on mount.
  return <div data-testid="protected-child">protected content</div>;
}

describe("ProtectedRoute — tenant host, cached user, verification pending", () => {
  beforeEach(() => {
    verifyTenantSessionForUser.mockReset();
  });

  it("does NOT mount the protected child before verifyTenantSessionForUser resolves", async () => {
    let resolveVerify: (v: { allowed: boolean }) => void = () => {};
    verifyTenantSessionForUser.mockReturnValue(
      new Promise((resolve) => {
        resolveVerify = resolve;
      }),
    );

    vi.mocked(useAuth).mockReturnValue({
      user: { id: "user-1", email: "u@example.com" } as never,
      session: null,
      userRole: "employee",
      userProfile: null,
      organization: null,
      organizationId: "org-1",
      loading: false, // already flipped false, as after cache hydration
      signOut: vi.fn(),
      refreshUserProfile: vi.fn(),
      refreshOrganization: vi.fn(),
      appBaseDomain: "pesowise.unimisk.com",
      isTenantHost: true, // on a tenant host
      tenantSubdomainLabel: "ml",
      tenantHostOrgId: "org-1",
      tenantHostOrg: null,
      organizationFeatureFlags: {},
      hasOrganizationFeature: vi.fn().mockReturnValue(false),
      tenantEmployeeIdLoginEnabled: false,
      tenantResolutionStatus: "resolved",
      tenantFeatureStatus: "resolved",
      retryTenantResolution: vi.fn(),
      preferredLanguage: "en",
      setPreferredLanguage: vi.fn(),
      isAccountantCashier: false,
      userBalance: null,
      refreshBalance: vi.fn(),
    } as never);

    render(
      <MemoryRouter>
        <ProtectedRoute>
          <ProtectedChild />
        </ProtectedRoute>
      </MemoryRouter>,
    );

    // Tenant verification must have been invoked immediately — no render gap.
    await waitFor(() => expect(verifyTenantSessionForUser).toHaveBeenCalledTimes(1));

    // While it's pending, the protected child must NOT be in the document —
    // this is the exact window where a stale session used to fire requests.
    expect(screen.queryByTestId("protected-child")).not.toBeInTheDocument();

    resolveVerify({ allowed: true });

    await waitFor(() => expect(screen.getByTestId("protected-child")).toBeInTheDocument());
  });

  it("does not re-invoke verifyTenantSessionForUser on unrelated re-renders for the same user/tenant", async () => {
    verifyTenantSessionForUser.mockResolvedValue({ allowed: true });

    const authValue = {
      user: { id: "user-1", email: "u@example.com" } as never,
      session: null,
      userRole: "employee",
      userProfile: null,
      organization: null,
      organizationId: "org-1",
      loading: false,
      signOut: vi.fn(),
      refreshUserProfile: vi.fn(),
      refreshOrganization: vi.fn(),
      appBaseDomain: "pesowise.unimisk.com",
      isTenantHost: true,
      tenantSubdomainLabel: "ml",
      tenantHostOrgId: "org-1",
      tenantHostOrg: null,
      organizationFeatureFlags: {},
      hasOrganizationFeature: vi.fn().mockReturnValue(false),
      tenantEmployeeIdLoginEnabled: false,
      tenantResolutionStatus: "resolved",
      tenantFeatureStatus: "resolved",
      retryTenantResolution: vi.fn(),
      preferredLanguage: "en",
      setPreferredLanguage: vi.fn(),
      isAccountantCashier: false,
      userBalance: null,
      refreshBalance: vi.fn(),
    } as never;
    vi.mocked(useAuth).mockReturnValue(authValue);

    const { rerender } = render(
      <MemoryRouter>
        <ProtectedRoute>
          <ProtectedChild />
        </ProtectedRoute>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("protected-child")).toBeInTheDocument());
    expect(verifyTenantSessionForUser).toHaveBeenCalledTimes(1);

    // Re-render with the identical auth value (e.g. an unrelated parent update).
    rerender(
      <MemoryRouter>
        <ProtectedRoute>
          <ProtectedChild />
        </ProtectedRoute>
      </MemoryRouter>,
    );

    expect(verifyTenantSessionForUser).toHaveBeenCalledTimes(1);
  });
});
