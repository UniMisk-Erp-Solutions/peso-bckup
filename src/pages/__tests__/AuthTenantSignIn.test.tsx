/**
 * Auth page — tenant identifier handling and same-origin behaviour.
 *
 * Reproduces the reported failure: on ml.pesowise.unimisk.com, employee ID 5003 was
 * rejected with "Enter your email address (include @)" because the page decided the
 * feature was off while the tenant lookups were still in flight (or had failed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import Auth from "@/pages/Auth";

const ML_ORIGIN = "https://ml.pesowise.unimisk.com";
const APEX_ORIGIN = "https://pesowise.unimisk.com";
const ORG_ID = "00000000-0000-0000-0000-0000000000ml";

const rpc = vi.fn();
const signInWithPassword = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: {
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  },
}));

vi.mock("@/lib/authSession", () => ({
  getValidatedAuthUser: vi.fn().mockResolvedValue({ user: null, error: null }),
  prepareForPasswordSignIn: vi.fn().mockResolvedValue(undefined),
  formatAuthErrorMessage: (e: { message?: string }) => e.message ?? "failed",
}));

vi.mock("@/lib/tenantAccess", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenantAccess")>("@/lib/tenantAccess");
  return {
    ...actual,
    assertEmailAllowedOnTenant: vi.fn().mockResolvedValue({ allowed: true }),
    verifyTenantSessionForUser: vi.fn().mockResolvedValue({ allowed: true }),
    rejectWrongTenantSession: vi.fn(),
  };
});

// Turnstile is not configured in this environment; the component renders nothing.
vi.mock("@/components/AuthTurnstile", () => ({ AuthTurnstile: () => null }));
vi.mock("@/components/DevTenantSelector", () => ({ DevTenantSelector: () => null }));

const mockedUseAuth = vi.mocked(useAuth);

type TenantState = {
  isTenantHost?: boolean;
  tenantResolutionStatus?: string;
  tenantFeatureStatus?: string;
  tenantEmployeeIdLoginEnabled?: boolean;
  tenantHostOrgId?: string | null;
};

const retryTenantResolution = vi.fn();

function mockTenant(state: TenantState) {
  mockedUseAuth.mockReturnValue({
    isTenantHost: true,
    tenantSubdomainLabel: "ml",
    tenantHostOrgId: ORG_ID,
    tenantHostOrg: { id: ORG_ID, name: "Mahalaxmi", slug: "ml", logo_url: null },
    tenantResolutionStatus: "resolved",
    tenantFeatureStatus: "resolved",
    tenantEmployeeIdLoginEnabled: true,
    retryTenantResolution,
    signOut: vi.fn(),
    loading: false,
    user: null,
    ...state,
  } as unknown as ReturnType<typeof useAuth>);
}

function setOrigin(href: string) {
  const url = new URL(href);
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
      search: "",
      replace: vi.fn(),
      assign: vi.fn(),
    },
  });
}

const originalLocation = window.location;

function renderAuth() {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={["/auth"]}>
        <Auth />
      </MemoryRouter>
    </HelmetProvider>,
  );
}

async function submit(identifier: string, password = "hunter22") {
  fireEvent.change(screen.getByLabelText(/Employee ID|Sign-in ID|Email/i), {
    target: { value: identifier },
  });
  fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

beforeEach(() => {
  rpc.mockReset();
  signInWithPassword.mockReset();
  signInWithPassword.mockResolvedValue({ error: null });
  retryTenantResolution.mockReset();
  localStorage.clear();
  setOrigin(`${ML_ORIGIN}/auth`);
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("Auth page — tenant identifier label", () => {
  it("does not show an email-only label while the tenant is still loading", () => {
    mockTenant({ tenantFeatureStatus: "loading" });
    renderAuth();
    expect(screen.getByTestId("tenant-resolving")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Email$/)).not.toBeInTheDocument();
  });

  it("shows 'Employee ID or Email' when the tenant resolves with the feature enabled", () => {
    mockTenant({});
    renderAuth();
    expect(screen.getByLabelText(/Employee ID or Email/i)).toBeInTheDocument();
  });

  it("shows email only when the feature is explicitly disabled", () => {
    mockTenant({ tenantEmployeeIdLoginEnabled: false });
    renderAuth();
    expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
    expect(screen.queryByTestId("tenant-lookup-failed")).not.toBeInTheDocument();
  });

  it("offers Retry — and does not claim the feature is disabled — when a lookup fails", () => {
    mockTenant({ tenantFeatureStatus: "error", tenantEmployeeIdLoginEnabled: false });
    renderAuth();
    expect(screen.getByTestId("tenant-lookup-failed")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Email$/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retryTenantResolution).toHaveBeenCalledTimes(1);
  });

  it("offers Retry when organization resolution fails", () => {
    mockTenant({ tenantResolutionStatus: "error", tenantHostOrgId: null });
    renderAuth();
    expect(screen.getByTestId("tenant-lookup-failed")).toBeInTheDocument();
  });
});

describe("Auth page — employee ID 5003", () => {
  it("accepts 5003 as an identifier and resolves it via get_employee_auth_email", async () => {
    mockTenant({});
    rpc.mockResolvedValue({ data: "emp5003@ml.internal", error: null });
    renderAuth();

    await submit("5003");

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("get_employee_auth_email", {
      p_organization_id: ORG_ID,
      p_employee_id: "5003",
    });
  });

  it("signs in with the resolved auth email, not the employee ID", async () => {
    mockTenant({});
    rpc.mockResolvedValue({ data: "emp5003@ml.internal", error: null });
    renderAuth();

    await submit("5003");

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(signInWithPassword.mock.calls[0][0]).toMatchObject({
      email: "emp5003@ml.internal",
      password: "hunter22",
    });
  });

  it("preserves leading zeros in the employee ID", async () => {
    mockTenant({});
    rpc.mockResolvedValue({ data: "emp0042@ml.internal", error: null });
    renderAuth();

    await submit("0042");

    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_employee_id: "0042" });
  });

  it("does not call the employee RPC while the tenant is still resolving", async () => {
    mockTenant({ tenantResolutionStatus: "loading", tenantHostOrgId: null });
    renderAuth();

    await submit("5003");

    await waitFor(() => expect(signInWithPassword).not.toHaveBeenCalled());
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("Auth page — origin is preserved", () => {
  it("never navigates away from the tenant origin on a successful sign-in", async () => {
    mockTenant({});
    rpc.mockResolvedValue({ data: "emp5003@ml.internal", error: null });
    renderAuth();

    await submit("5003");

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(window.location.replace).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(window.location.origin).toBe(ML_ORIGIN);
  });

  it("stays on the tenant origin when sign-in fails", async () => {
    mockTenant({});
    rpc.mockResolvedValue({ data: "emp5003@ml.internal", error: null });
    signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    renderAuth();

    await submit("5003");

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(window.location.replace).not.toHaveBeenCalled();
    expect(window.location.origin).toBe(ML_ORIGIN);
  });

  it("still allows email sign-in on the apex", async () => {
    setOrigin(`${APEX_ORIGIN}/auth`);
    mockedUseAuth.mockReturnValue({
      isTenantHost: false,
      tenantSubdomainLabel: null,
      tenantHostOrgId: null,
      tenantHostOrg: null,
      tenantResolutionStatus: "idle",
      tenantFeatureStatus: "idle",
      tenantEmployeeIdLoginEnabled: false,
      retryTenantResolution,
      signOut: vi.fn(),
      loading: false,
      user: null,
    } as unknown as ReturnType<typeof useAuth>);
    renderAuth();

    expect(screen.getByLabelText(/^Email$/)).toBeInTheDocument();
    await submit("someone@example.com");

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(signInWithPassword.mock.calls[0][0]).toMatchObject({ email: "someone@example.com" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("Auth page — Turnstile configuration is not leaked", () => {
  it("does not display the VITE_TURNSTILE_SITE_KEY environment variable name", () => {
    mockTenant({});
    const { container } = renderAuth();
    expect(container.textContent ?? "").not.toContain("VITE_TURNSTILE_SITE_KEY");
    expect(container.textContent ?? "").not.toMatch(/VITE_/);
  });

  it("does not block sign-in when Turnstile is not configured", async () => {
    mockTenant({});
    rpc.mockResolvedValue({ data: "emp5003@ml.internal", error: null });
    renderAuth();

    expect(screen.getByRole("button", { name: /sign in/i })).not.toBeDisabled();
    await submit("5003");
    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
  });
});
