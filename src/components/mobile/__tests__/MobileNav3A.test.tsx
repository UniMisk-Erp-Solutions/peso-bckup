import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileBottomNav } from "../MobileBottomNav";
import { MobileMoreSheet } from "../MobileMoreSheet";
import { MobileAppShell } from "../MobileAppShell";

// ── Shared mocks ──────────────────────────────────────────────────────────────

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    userRole: "employee",
    isAccountantCashier: false,
    userProfile: { name: "Test User" },
    signOut: vi.fn(),
    organizationFeatureFlags: [],
    isTenantHost: false,
    tenantHostOrgId: null,
    organizationId: "org-1",
  })),
}));

vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({
  useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }),
}));

vi.mock("@/hooks/usePendingTransferOfferCount", () => ({
  usePendingTransferOfferCount: () => ({ count: 0, enabled: false, refresh: vi.fn() }),
}));

vi.mock("@/lib/orgFeatureGates", () => ({
  hasApprovalHierarchy: () => false,
  hasTeamsEnabled: () => false,
  // employee_transfer_history off — this suite covers the default nav layout.
  isOrganizationFeatureActive: () => false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        allExpenses: "All Expenses",
        balances: "Balances",
        manageUsers: "Manage Users",
        categories: "Categories",
        reports: "Reports",
        analytics: "Analytics",
        notifications: "Notifications",
        settings: "Settings",
        help: "Help & Tutorial",
        myTeams: "My Teams",
        teamReports: "Team Reports",
        signOut: "Sign Out",
        sectionWorkspace: "Workspace",
        sectionAdministration: "Administration",
        sectionAccount: "Account",
        approvedExpenses: "Approved Expenses",
        transactionHistory: "Transaction History",
        transferHistory: "Transfer History",
        transferOffers: "Transfer offers",
        reviewExpenses: "Review Expenses",
      };
      return map[key] ?? key;
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DrawerContent: ({ children, ...rest }: { children: React.ReactNode; [k: string]: unknown }) => (
    <div {...rest}>{children}</div>
  ),
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: vi.fn(() => vi.fn()) };
});

const { useAuth } = await import("@/contexts/AuthContext");

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderNav(role: string, isAccountantCashier = false) {
  vi.mocked(useAuth).mockReturnValue({
    userRole: role,
    isAccountantCashier,
    userProfile: { name: "Test" },
    signOut: vi.fn(),
    organizationFeatureFlags: [],
    isTenantHost: false,
    tenantHostOrgId: null,
    organizationId: "org-1",
  } as any);
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <MobileBottomNav onMorePress={vi.fn()} />
    </MemoryRouter>,
  );
}

function renderSheet(role: string, open = true) {
  vi.mocked(useAuth).mockReturnValue({
    userRole: role,
    isAccountantCashier: false,
    userProfile: { name: "Test" },
    signOut: vi.fn(),
    organizationFeatureFlags: [],
    isTenantHost: false,
    tenantHostOrgId: null,
    organizationId: "org-1",
  } as any);
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter>
      <MobileMoreSheet open={open} onOpenChange={onOpenChange} />
    </MemoryRouter>,
  );
  return { onOpenChange };
}

// ── Test 1: Employee bottom nav ───────────────────────────────────────────────

describe("1 — Employee bottom nav", () => {
  beforeEach(() => vi.clearAllMocks());

  it("employee has More button", () => {
    renderNav("employee");
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  it("employee does NOT have a Review link", () => {
    renderNav("employee");
    expect(screen.queryByRole("link", { name: /review/i })).not.toBeInTheDocument();
  });
});

// ── Test 2: Reviewer bottom nav ───────────────────────────────────────────────

describe("2 — Reviewer bottom nav", () => {
  beforeEach(() => vi.clearAllMocks());

  it("engineer has Review link", () => {
    renderNav("engineer");
    expect(screen.getByRole("link", { name: /review/i })).toBeInTheDocument();
  });

  it("engineer has More button", () => {
    renderNav("engineer");
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  it("team_leader has both Review and More", () => {
    renderNav("team_leader");
    expect(screen.getByRole("link", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  it("executive has both Review and More", () => {
    renderNav("executive");
    expect(screen.getByRole("link", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });
});

// ── Test 3: Admin bottom nav (5-item) ────────────────────────────────────────

describe("3 — Admin bottom nav (5-item)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admin does NOT have Review link in bottom nav", () => {
    renderNav("admin");
    expect(screen.queryByRole("link", { name: /review/i })).not.toBeInTheDocument();
  });

  it("admin has More button", () => {
    renderNav("admin");
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  it("admin nav has 5 slots (home/expenses/fab/allExpenses/more)", () => {
    renderNav("admin");
    // Home is active at /dashboard so its accessible name becomes "Home (current page)"
    expect(screen.getByRole("link", { name: /^home/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Expenses" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /review/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("New expense")).toBeInTheDocument();
    // All Expenses has aria-label="All Expenses" — exact accessible name
    expect(screen.getByRole("link", { name: "All Expenses" })).toBeInTheDocument();
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  it("admin nav has 3 links and 2 buttons", () => {
    renderNav("admin");
    const links = screen.getAllByRole("link");
    const buttons = screen.getAllByRole("button");
    // links: Home, Expenses, All Expenses = 3
    // buttons: FAB (New expense), More options = 2
    expect(links).toHaveLength(3);
    expect(buttons).toHaveLength(2);
  });
});

// ── Test 4: Admin More sheet — authorised admin routes only ───────────────────

describe("4 — Admin More sheet authorised routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admin More sheet does NOT duplicate All Expenses (moved to nav)", () => {
    renderSheet("admin");
    expect(screen.queryByText("All Expenses")).not.toBeInTheDocument();
  });

  it("exposes Manage Users link", () => {
    renderSheet("admin");
    expect(screen.getByText("Manage Users")).toBeInTheDocument();
  });

  it("exposes Categories link", () => {
    renderSheet("admin");
    expect(screen.getByText("Categories")).toBeInTheDocument();
  });

  it("exposes Settings link", () => {
    renderSheet("admin");
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("shows Administration section heading", () => {
    renderSheet("admin");
    expect(screen.getByText("Administration")).toBeInTheDocument();
  });

  it("shows Workspace section heading", () => {
    renderSheet("admin");
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("admin More sheet does NOT contain Review Expenses", () => {
    renderSheet("admin");
    expect(screen.queryByText("Review Expenses")).not.toBeInTheDocument();
  });
});

// ── Test 5: Employee More sheet — no admin routes ─────────────────────────────

describe("5 — Employee More sheet — no admin-only routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not expose All Expenses", () => {
    renderSheet("employee");
    expect(screen.queryByText("All Expenses")).not.toBeInTheDocument();
  });

  it("does not expose Manage Users", () => {
    renderSheet("employee");
    expect(screen.queryByText("Manage Users")).not.toBeInTheDocument();
  });

  it("does not expose Categories", () => {
    renderSheet("employee");
    expect(screen.queryByText("Categories")).not.toBeInTheDocument();
  });

  it("does not show Administration section heading", () => {
    renderSheet("employee");
    expect(screen.queryByText("Administration")).not.toBeInTheDocument();
  });

  it("employee sheet contains Notifications but not Settings (Settings is a direct nav tab)", () => {
    renderSheet("employee");
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });
});

// ── Test 6: More sheet opens and closes ───────────────────────────────────────

describe("6 — More sheet open/close lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sheet content is visible when open=true", () => {
    renderSheet("employee", true);
    expect(screen.getByTestId("more-sheet")).toBeInTheDocument();
  });

  it("sheet content is absent when open=false", () => {
    renderSheet("employee", false);
    expect(screen.queryByTestId("more-sheet")).not.toBeInTheDocument();
  });

  it("clicking a sheet item calls onOpenChange(false)", () => {
    const { onOpenChange } = renderSheet("employee", true);
    const notifLink = screen.getByText("Notifications");
    fireEvent.click(notifLink);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ── Test 7: Sheet item navigates and closes ───────────────────────────────────

describe("7 — Sheet item navigate + close", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clicking Settings link closes the sheet", () => {
    const { onOpenChange } = renderSheet("admin", true);
    const settingsLink = screen.getAllByText("Settings")[0];
    fireEvent.click(settingsLink);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// ── Test 8: Reviewer/admin nav — layout classes prevent overflow ──────────────

describe("8 — 5-item nav layout (reviewer/admin)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("nav element does NOT carry position:fixed class", () => {
    renderNav("admin");
    const nav = screen.getByRole("navigation");
    expect(nav.className).not.toMatch(/\bfixed\b/);
  });

  it("nav uses shrink-0 class (in-flow, no fixed position)", () => {
    renderNav("engineer");
    const nav = screen.getByRole("navigation");
    expect(nav.className).toMatch(/\bshrink-0\b/);
  });

  it("More button has min-w-0 to prevent horizontal overflow", () => {
    renderNav("admin");
    const moreBtn = screen.getByLabelText("More options");
    // min-w-0 is expressed via the TAB_BASE class on the button
    expect(moreBtn.className).toMatch(/min-w-0/);
  });

  it("reviewer nav has 5 interactive elements (home/expenses/fab/review/more)", () => {
    renderNav("engineer");
    const links = screen.getAllByRole("link");
    const buttons = screen.getAllByRole("button");
    // links: Home, Expenses, Review = 3
    // buttons: FAB (New expense), More options = 2
    expect(links).toHaveLength(3);
    expect(buttons).toHaveLength(2);
  });
});

// ── Test 9: Desktop viewport — mobile shell not mounted ───────────────────────

describe("9 — Desktop viewport gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("MobileAppShell always renders mobile-app-shell class when mounted (only mounted when isMobile=true in Layout)", () => {
    vi.mocked(useAuth).mockReturnValue({
      userRole: "employee",
      isAccountantCashier: false,
      userProfile: { name: "Test" },
      signOut: vi.fn(),
      organizationFeatureFlags: [],
      isTenantHost: false,
      tenantHostOrgId: null,
      organizationId: "org-1",
    } as any);
    const { container } = render(
      <MemoryRouter>
        <MobileAppShell>content</MobileAppShell>
      </MemoryRouter>,
    );
    // MobileAppShell is only mounted by Layout.tsx when useViewportMode().isMobile === true
    // This confirms the class is correct when mounted; Layout gates the mount.
    expect(container.querySelector(".mobile-app-shell")).toBeInTheDocument();
  });

  it("MobileBottomNav nav element has shrink-0 (in-flow, never position:fixed)", () => {
    renderNav("employee");
    const nav = screen.getByRole("navigation");
    expect(nav.className).toMatch(/shrink-0/);
    expect(nav.className).not.toMatch(/\bfixed\b/);
  });
});
