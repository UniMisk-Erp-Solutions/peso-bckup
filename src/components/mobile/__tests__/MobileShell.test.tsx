import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileBottomNav } from "../MobileBottomNav";
import { MobileAppShell } from "../MobileAppShell";
import { MobileDashboardView } from "../MobileDashboardView";

// ── Shared mocks ──────────────────────────────────────────────────────────────

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    userRole: "employee",
    isAccountantCashier: false,
    userProfile: { name: "Test User" },
  })),
}));

vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({
  useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }),
}));

vi.mock("@/hooks/usePendingTransferOfferCount", () => ({
  usePendingTransferOfferCount: () => ({ count: 0, enabled: false, refresh: vi.fn() }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: vi.fn(() => vi.fn()) };
});

const { useAuth } = await import("@/contexts/AuthContext");

// ── MobileBottomNav — role-aware navigation ───────────────────────────────────

function renderNav(role: string, isAccountantCashier = false) {
  vi.mocked(useAuth).mockReturnValue({
    userRole: role,
    isAccountantCashier,
    userProfile: { name: "Test" },
  } as any);
  return render(
    <MemoryRouter>
      <MobileBottomNav onMorePress={vi.fn()} />
    </MemoryRouter>,
  );
}

describe("MobileBottomNav — role-aware tabs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reviewer role (engineer) gets Review link", () => {
    renderNav("engineer");
    expect(screen.getByRole("link", { name: /review/i })).toBeInTheDocument();
  });

  it("admin does NOT get Review link in bottom nav (Review lives in More sheet)", () => {
    renderNav("admin");
    expect(screen.queryByRole("link", { name: /review/i })).not.toBeInTheDocument();
  });

  it("employee gets More button and no Review link", () => {
    renderNav("employee");
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /review/i })).not.toBeInTheDocument();
  });

  it("nav element does not carry position:fixed class", () => {
    renderNav("employee");
    const nav = screen.getByRole("navigation");
    expect(nav.className).not.toMatch(/\bfixed\b/);
  });
});

// ── MobileAppShell — scroll architecture ─────────────────────────────────────

describe("MobileAppShell — scroll container", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      userRole: "employee",
      isAccountantCashier: false,
      userProfile: { name: "Test" },
    } as any);
  });

  it("outer wrapper uses mobile-app-shell class", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileAppShell>
          <p>content</p>
        </MobileAppShell>
      </MemoryRouter>,
    );
    expect(container.querySelector(".mobile-app-shell")).toBeInTheDocument();
  });

  it("scroll region uses mobile-app-scroll class", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileAppShell>
          <p>content</p>
        </MobileAppShell>
      </MemoryRouter>,
    );
    expect(container.querySelector(".mobile-app-scroll")).toBeInTheDocument();
  });

  it("there is exactly one mobile-app-scroll element (no duplicate scroll owners)", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileAppShell>
          <p>content</p>
        </MobileAppShell>
      </MemoryRouter>,
    );
    expect(container.querySelectorAll(".mobile-app-scroll")).toHaveLength(1);
  });

  it("children render inside the scroll region", () => {
    render(
      <MemoryRouter>
        <MobileAppShell>
          <p>hello world</p>
        </MobileAppShell>
      </MemoryRouter>,
    );
    const scroll = document.querySelector(".mobile-app-scroll");
    expect(scroll?.textContent).toContain("hello world");
  });
});

// ── MobileDashboardView — metric label clarity ────────────────────────────────

const baseStats = {
  totalExpenses: 5,
  pendingAmount: 1500,
  approvedAmount: 3000,
  currentBalance: 10000,
  pendingReviews: 0,
  pendingApprovals: 0,
};

function renderDashboard(overrides?: Partial<typeof baseStats>, role = "employee") {
  return render(
    <MemoryRouter>
      <MobileDashboardView
        stats={{ ...baseStats, ...overrides }}
        loading={false}
        statsRefreshing={false}
        notifications={[]}
        userRole={role}
        userBalance={10000}
        isAccountantCashier={false}
        allowCashierExpenseSubmission={null}
      />
    </MemoryRouter>,
  );
}

describe("MobileDashboardView — metric labels", () => {
  it("pending stat is labelled 'Pending amount' not vague 'Pending'", () => {
    renderDashboard();
    expect(screen.getByText("Pending amount")).toBeInTheDocument();
  });

  it("expense count subtext does not render bare 'total' word", () => {
    renderDashboard({ totalExpenses: 5 });
    // The text should be "5 expenses", never just "total"
    expect(screen.queryByText(/\btotal\b/i)).not.toBeInTheDocument();
  });

  it("shows singular 'expense' for count of 1", () => {
    renderDashboard({ totalExpenses: 1 });
    expect(screen.getByText("1 expense")).toBeInTheDocument();
  });

  it("shows plural 'expenses' for count > 1", () => {
    renderDashboard({ totalExpenses: 3 });
    expect(screen.getByText("3 expenses")).toBeInTheDocument();
  });

  it("reviewer role (engineer) shows 'Pending amount' stat label", () => {
    renderDashboard({}, "engineer");
    expect(screen.getByText("Pending amount")).toBeInTheDocument();
  });

  it("admin role with 0 approvals shows 'No pending approvals'", () => {
    renderDashboard({ pendingApprovals: 0 }, "admin");
    expect(screen.getByText("No pending approvals")).toBeInTheDocument();
  });

  it("employee role shows 'Approved amount' label", () => {
    renderDashboard({}, "employee");
    expect(screen.getByText("Approved amount")).toBeInTheDocument();
  });
});
