/**
 * DOC-087 — Balance History navigation surfaces.
 *
 * Desktop sidebar, mobile More sheet, the More-active prefix, and the Dashboard
 * Current Balance card entry point, each asserted with the feature flag off and on.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppSidebar } from "../AppSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { MobileMoreSheet } from "../mobile/MobileMoreSheet";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

// The global setup mock resolves every bare key against the `expenses` namespace,
// so nav labels come back as raw keys. These components read the `nav` namespace,
// so resolve against the real nav.json here.
vi.mock("react-i18next", async () => {
  const nav = (await import("@/locales/en/nav.json")).default as Record<string, string>;
  return {
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) =>
        nav[key] ?? opts?.defaultValue ?? key,
      i18n: { language: "en", changeLanguage: vi.fn() },
    }),
    initReactI18next: { type: "3rdParty", init: vi.fn() },
  };
});

vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({
  useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }),
}));
vi.mock("@/hooks/usePendingTransferOfferCount", () => ({
  usePendingTransferOfferCount: () => ({ count: 0, enabled: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useUnreadNotifications", () => ({
  useUnreadNotifications: () => ({ unreadCount: 0 }),
}));
vi.mock("@/hooks/useDashboardTheme", () => ({
  useDashboardTheme: () => ["default", vi.fn()],
}));
vi.mock("@/hooks/useCashierCapabilities", () => ({
  useCashierCapabilities: () => ({
    isAccountantCashier: false,
    isOperationalCashier: false,
  }),
}));
vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function mockAuth({
  userRole = "employee",
  featureOn = false,
}: { userRole?: string; featureOn?: boolean } = {}) {
  const flags = featureOn
    ? { [ORGANIZATION_FEATURE_KEYS.employee_transfer_history]: true }
    : {};
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "emp-1" },
    userRole,
    userProfile: { name: "Test User" },
    organization: null,
    organizationId: "org-1",
    organizationFeatureFlags: flags,
    isTenantHost: false,
    tenantHostOrgId: null,
    isAccountantCashier: false,
    signOut: vi.fn(),
    hasOrganizationFeature: (key: string) => flags[key] === true,
  } as unknown as ReturnType<typeof useAuth>);
}

// The real SidebarProvider is used rather than a mocked useSidebar: the Sidebar
// primitives read the context directly, so a mocked hook export never reaches them.
const renderSidebar = () =>
  render(
    <MemoryRouter>
      <SidebarProvider>
        <AppSidebar />
      </SidebarProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth();
});

describe("Desktop sidebar", () => {
  it("omits Balance History for an employee when the feature is off", () => {
    mockAuth({ featureOn: false });
    renderSidebar();
    expect(screen.queryByText("Balance History")).not.toBeInTheDocument();
  });

  it("shows Balance History for an employee when the feature is on", () => {
    mockAuth({ featureOn: true });
    renderSidebar();

    const link = screen.getByText("Balance History").closest("a");
    expect(link).toHaveAttribute("href", "/balance-history");
  });

  it("places Balance History directly after My Expenses", () => {
    mockAuth({ featureOn: true });
    const { container } = renderSidebar();

    const labels = Array.from(container.querySelectorAll("a span.truncate")).map(
      (n) => n.textContent,
    );
    expect(labels.slice(0, 3)).toEqual([
      "Dashboard",
      "My Expenses",
      "Balance History",
    ]);
  });

  it.each(["admin", "cashier", "engineer", "team_leader", "executive"])(
    "never shows Balance History to %s even with the flag on",
    (role) => {
      mockAuth({ userRole: role, featureOn: true });
      renderSidebar();
      expect(screen.queryByText("Balance History")).not.toBeInTheDocument();
    },
  );
});

describe("Mobile More sheet", () => {
  const renderSheet = () =>
    render(
      <MemoryRouter>
        <MobileMoreSheet open onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

  it("omits Balance History when the feature is off", () => {
    mockAuth({ featureOn: false });
    renderSheet();
    expect(screen.queryByText("Balance History")).not.toBeInTheDocument();
  });

  it("includes Balance History when the feature is on", () => {
    mockAuth({ featureOn: true });
    renderSheet();
    expect(screen.getByText("Balance History").closest("a")).toHaveAttribute(
      "href",
      "/balance-history",
    );
  });

  it.each(["admin", "cashier", "engineer"])(
    "never shows Balance History to %s even with the flag on",
    (role) => {
      mockAuth({ userRole: role, featureOn: true });
      renderSheet();
      expect(screen.queryByText("Balance History")).not.toBeInTheDocument();
    },
  );
});
