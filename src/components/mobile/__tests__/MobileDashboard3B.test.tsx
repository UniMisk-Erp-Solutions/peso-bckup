import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileDashboardView } from "../MobileDashboardView";

// ── Shared mocks ──────────────────────────────────────────────────────────────

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    user: { id: "user-1" },
    userRole: "employee",
    isAccountantCashier: false,
    organizationFeatureFlags: [],
    hasOrganizationFeature: () => false,
  })),
}));

vi.mock("@/components/DashboardPendingTransferOffers", () => ({
  DashboardPendingTransferOffers: () => (
    <div data-testid="transfer-offers">Transfer Offers</div>
  ),
}));

vi.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: vi.fn(() => vi.fn()) };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_STATS = {
  totalExpenses: 0,
  pendingAmount: 0,
  approvedAmount: 0,
  currentBalance: 0,
  pendingReviews: 0,
  pendingReviewsAmount: 0,
  pendingApprovals: 0,
  pendingApprovalsAmount: 0,
  totalEmployeeBalance: 0,
  totalEngineerBalance: 0,
  totalCashierBalance: 0,
};

function renderDashboard(
  role: string,
  overrides: Partial<typeof BASE_STATS> = {},
  extra: Record<string, unknown> = {},
) {
  return render(
    <MemoryRouter>
      <MobileDashboardView
        stats={{ ...BASE_STATS, ...overrides }}
        loading={false}
        statsRefreshing={false}
        notifications={[]}
        userRole={role}
        userBalance={null}
        isAccountantCashier={false}
        allowCashierExpenseSubmission={null}
        {...extra}
      />
    </MemoryRouter>,
  );
}

// ── Test 5: No ₹0 fallback while loading ─────────────────────────────────────

describe("5 — No ₹0oo fallback while loading", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders skeleton when loading=true, not stat values", () => {
    render(
      <MemoryRouter>
        <MobileDashboardView
          stats={BASE_STATS}
          loading={true}
          statsRefreshing={false}
          notifications={[]}
          userRole="employee"
          userBalance={null}
          isAccountantCashier={false}
          allowCashierExpenseSubmission={null}
        />
      </MemoryRouter>,
    );
    // Skeleton elements use aria-busy or just render as divs — verify no ₹0 money string
    expect(screen.queryByText(/₹0/)).not.toBeInTheDocument();
    // No "Balance" heading either
    expect(screen.queryByText("Balance")).not.toBeInTheDocument();
  });

  it("renders content once loading=false", () => {
    renderDashboard("employee", { currentBalance: 500 });
    expect(screen.getByText("Balance")).toBeInTheDocument();
  });
});

// ── Test 6: Real desktop-provided metrics rendered ────────────────────────────

describe("6 — Real desktop-provided metrics rendered", () => {
  beforeEach(() => vi.clearAllMocks());

  it("employee: shows pending amount", () => {
    renderDashboard("employee", { pendingAmount: 1200 });
    expect(screen.getByText("Pending amount")).toBeInTheDocument();
  });

  it("employee: shows approved amount", () => {
    renderDashboard("employee", { approvedAmount: 5000 });
    expect(screen.getByText("Approved amount")).toBeInTheDocument();
  });

  it("engineer: shows pending reviews CTA when pendingReviews > 0", () => {
    renderDashboard("engineer", { pendingReviews: 3 });
    expect(screen.getByText(/3 reviews pending/i)).toBeInTheDocument();
  });

  it("admin: shows pending approvals CTA when pendingApprovals > 0", () => {
    renderDashboard("admin", { pendingApprovals: 5 });
    expect(screen.getByText(/5 approvals pending/i)).toBeInTheDocument();
  });

  it("admin: shows 'No pending approvals' when count is 0", () => {
    renderDashboard("admin", { pendingApprovals: 0 });
    expect(screen.getByText("No pending approvals")).toBeInTheDocument();
  });

  it("admin: shows org balance section when balances > 0", () => {
    renderDashboard("admin", {
      totalEmployeeBalance: 10000,
      totalEngineerBalance: 5000,
      totalCashierBalance: 2000,
    });
    expect(screen.getByText("Organisation Balances")).toBeInTheDocument();
    expect(screen.getByText("Employee")).toBeInTheDocument();
    expect(screen.getByText("Manager")).toBeInTheDocument();
    expect(screen.getByText("Cashier")).toBeInTheDocument();
  });

  it("admin: hides org balance section when all balances are 0", () => {
    renderDashboard("admin", {
      totalEmployeeBalance: 0,
      totalEngineerBalance: 0,
      totalCashierBalance: 0,
    });
    expect(screen.queryByText("Organisation Balances")).not.toBeInTheDocument();
  });

  it("cashier: renders DashboardPendingTransferOffers", () => {
    renderDashboard("cashier");
    expect(screen.getByTestId("transfer-offers")).toBeInTheDocument();
  });
});

// ── Test 7: True empty state only when data genuinely empty ───────────────────

describe("7 — True empty state when data is genuinely empty", () => {
  beforeEach(() => vi.clearAllMocks());

  it("engineer: no reviews CTA when pendingReviews is 0", () => {
    renderDashboard("engineer", { pendingReviews: 0 });
    expect(screen.queryByText(/reviews pending/i)).not.toBeInTheDocument();
  });

  it("cashier: no return requests section when list is empty", () => {
    renderDashboard("cashier", {}, { returnRequests: [] });
    expect(screen.queryByText("Return Requests")).not.toBeInTheDocument();
  });

  it("cashier: shows return requests when list is non-empty", () => {
    renderDashboard(
      "cashier",
      {},
      {
        returnRequests: [
          { id: "r1", requester_name: "Alice", amount: 500, note: "test" },
        ],
        onApproveRequest: vi.fn(),
        onRejectRequest: vi.fn(),
      },
    );
    expect(screen.getByText("Return Requests")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("employee: Return Money button visible when onReturnMoney provided", () => {
    renderDashboard("employee", {}, { onReturnMoney: vi.fn() });
    expect(screen.getByText("Return Money")).toBeInTheDocument();
  });

  it("employee: Return Money button hidden when onReturnMoney not provided", () => {
    renderDashboard("employee");
    expect(screen.queryByText("Return Money")).not.toBeInTheDocument();
  });

  it("all roles: My Expenses quick link is always present", () => {
    for (const role of ["employee", "engineer", "admin", "cashier"]) {
      const { unmount } = renderDashboard(role);
      expect(
        screen.getByRole("button", { name: /expenses/i }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});
