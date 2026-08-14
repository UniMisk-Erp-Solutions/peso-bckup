/**
 * Phase 6A tests — Mobile Admin Panel & All Expenses
 * T1–T5:  MobileAdminExpenseCard
 * T6–T9:  MobileAdminExpensesView
 * T10–T13: MobileAdminExpenseDetailView
 * T14–T15: MobileTopBar — batch review `?from=admin` back nav
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// ── Shared mocks ─────────────────────────────────────────────────────────────

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => Promise.resolve({ data: [], error: null })),
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
          in: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
    })),
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    userRole: "admin",
    organizationId: "org1",
    organizationFeatureFlags: {},
    hasOrganizationFeature: () => false,
  }),
}));

vi.mock("@/i18n", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (k: string) => k,
    i18n: { language: "en" },
  }),
}));

vi.mock("@/components/ExpenseStatusWithCorrectionBadge", () => ({
  ExpenseStatusWithCorrectionBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

vi.mock("@/components/ExpenseFormFieldsDisplay", () => ({
  ExpenseFormFieldsDisplay: () => null,
}));

vi.mock("@/components/ExpenseReviewTimeline", () => ({
  ExpenseReviewTimeline: () => <div data-testid="review-timeline" />,
}));

vi.mock("@/components/ExpenseCorrectionAudit", () => ({
  ExpenseCorrectionAuditList: () => null,
}));

vi.mock("@/components/AttachmentThumbnail", () => ({
  AttachmentThumbnail: () => null,
}));

vi.mock("@/components/ExpenseCustomFieldFilters", () => ({
  ExpenseCustomFieldFilters: () => null,
}));

vi.mock("@/hooks/useOrganizationRoleLabels", () => ({
  useOrganizationRoleLabels: () => ({ roleLabels: {} }),
}));

vi.mock("@/hooks/useOrganizationExpenseFormConfig", () => ({
  useOrganizationExpenseFormConfig: () => ({
    config: {},
    rawConfig: {},
    isLoading: false,
    isError: false,
    error: null,
    isDefault: true,
    getFieldLabel: (key: string) => key,
    isVisibleOnReview: () => true,
    isVisibleOnDetail: () => true,
  }),
}));

vi.mock("@/lib/pageTitle", () => ({
  getPageTitle: () => "All Expenses",
}));

vi.mock("@/lib/formatLocale", () => ({
  getDateLocale: () => undefined,
}));

// ── MobileTopBar navigate mock ────────────────────────────────────────────────

const mockNavigate = vi.fn();
let mockLocationValue = { pathname: "/", search: "" };

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocationValue,
  };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

import type { AdminExpenseRow } from "../MobileAdminExpenseCard";

function makeExpense(overrides: Partial<AdminExpenseRow> = {}): AdminExpenseRow {
  return {
    id: "exp-1",
    title: "Hotel Stay",
    destination: "Mumbai",
    trip_start: "2026-07-01",
    trip_end: "2026-07-01",
    status: "submitted",
    total_amount: 5000,
    created_at: "2026-07-01T10:00:00Z",
    user_id: "u1",
    user_name: "Alice Sharma",
    user_email: "alice@example.com",
    user_employee_id: "EMP001",
    user_balance: 10000,
    transaction_number: "TXN-001",
    batch_id: null,
    isResubmitted: false,
    wasReviewerCorrected: false,
    category: "travel",
    purpose: "Conference",
    ...overrides,
  };
}

// ============================================================
// GROUP 1 — MobileAdminExpenseCard
// ============================================================

import { MobileAdminExpenseCard } from "../MobileAdminExpenseCard";

describe("MobileAdminExpenseCard", () => {
  it("T1: renders employee name", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpenseCard
          expense={makeExpense()}
          onSelect={() => undefined}
          employeeIdLoginEnabled={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Alice Sharma")).toBeInTheDocument();
  });

  it("T2: renders formatted amount", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpenseCard
          expense={makeExpense({ total_amount: 5000 })}
          onSelect={() => undefined}
          employeeIdLoginEnabled={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/5,000/)).toBeInTheDocument();
  });

  it("T3: renders Batch badge for batch expenses", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpenseCard
          expense={makeExpense({ batch_id: "batch-1" })}
          onSelect={() => undefined}
          employeeIdLoginEnabled={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Batch")).toBeInTheDocument();
  });

  it("T4: calls onSelect with the correct expense when tapped", () => {
    const onSelect = vi.fn();
    const expense = makeExpense();
    render(
      <MemoryRouter>
        <MobileAdminExpenseCard
          expense={expense}
          onSelect={onSelect}
          employeeIdLoginEnabled={false}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(expense);
  });

  it("T5: uses .mobile-admin-expense-card class (no table)", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileAdminExpenseCard
          expense={makeExpense()}
          onSelect={() => undefined}
          employeeIdLoginEnabled={false}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".mobile-admin-expense-card")).toBeInTheDocument();
  });
});

// ============================================================
// GROUP 2 — MobileAdminExpensesView
// ============================================================

import { MobileAdminExpensesView } from "../MobileAdminExpensesView";

const baseStats = {
  totalExpenses: 10,
  pendingExpenses: 3,
  approvedExpenses: 5,
  totalAmount: 50000,
  totalUsers: 8,
};

const baseExpensesViewProps = {
  stats: baseStats,
  expensesLoading: false,
  searchTerm: "",
  setSearchTerm: vi.fn(),
  statusFilter: "all",
  setStatusFilter: vi.fn(),
  customFieldFilters: {},
  setCustomFieldFilters: vi.fn(),
  filterableCustomFields: [],
  totalExpenseCount: 10,
  expenses: [],
  allExpensesLoaded: true,
  loadingAllExpenses: false,
  onLoadAllExpenses: vi.fn(),
  onSelectExpense: vi.fn(),
  employeeIdLoginEnabled: false,
};

describe("MobileAdminExpensesView", () => {
  it("T6: renders one card per expense", () => {
    const expenses = [makeExpense({ id: "e1" }), makeExpense({ id: "e2", title: "Flight" })];
    render(
      <MemoryRouter>
        <MobileAdminExpensesView
          {...baseExpensesViewProps}
          filteredExpenses={expenses}
          expenses={expenses}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId("admin-expense-card")).toHaveLength(2);
  });

  it("T7: shows empty-state message when no expenses", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpensesView
          {...baseExpensesViewProps}
          filteredExpenses={[]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("admin-expenses-empty")).toBeInTheDocument();
  });

  it("T8: renders totalUsers stat", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpensesView
          {...baseExpensesViewProps}
          filteredExpenses={[]}
          stats={{ ...baseStats, totalUsers: 42 }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("T9: has no table element", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileAdminExpensesView
          {...baseExpensesViewProps}
          filteredExpenses={[makeExpense()]}
          expenses={[makeExpense()]}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector("table")).toBeNull();
  });

  it("T15: calls onSelectExpense with the correct expense when a card is tapped", () => {
    const onSelect = vi.fn();
    const expense = makeExpense();
    render(
      <MemoryRouter>
        <MobileAdminExpensesView
          {...baseExpensesViewProps}
          filteredExpenses={[expense]}
          expenses={[expense]}
          onSelectExpense={onSelect}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("admin-expense-card"));
    expect(onSelect).toHaveBeenCalledWith(expense);
  });
});

// ============================================================
// GROUP 3 — MobileAdminExpenseDetailView
// ============================================================

import { MobileAdminExpenseDetailView } from "../MobileAdminExpenseDetailView";

const baseDetailProps = {
  expense: makeExpense(),
  attachments: [],
  auditLogs: [],
  correctionLogs: [],
  adminComment: "",
  setAdminComment: vi.fn(),
  selectedStatus: "",
  setSelectedStatus: vi.fn(),
  selectedEngineer: "",
  setSelectedEngineer: vi.fn(),
  engineers: [],
  reviewLoading: false,
  hierarchyEnabled: false,
  teamLeaderTierEnabled: false,
  executiveTierEnabled: false,
  canCorrect: false,
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onVerify: vi.fn(),
  onUpdateStatus: vi.fn().mockResolvedValue(undefined),
  onOpenCorrection: vi.fn(),
  onClose: vi.fn(),
  organizationId: "org1",
  onImagePreviewOpen: vi.fn(),
  employeeIdLoginEnabled: false,
  timelineAssignees: {},
};

describe("MobileAdminExpenseDetailView", () => {
  it("T10: renders expense title", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpenseDetailView {...baseDetailProps} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Hotel Stay")).toBeInTheDocument();
  });

  it("T11: renders back button with accessible label", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpenseDetailView {...baseDetailProps} />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: /back to expense list/i }),
    ).toBeInTheDocument();
  });

  it("T12: calls onClose when back button is clicked", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <MobileAdminExpenseDetailView {...baseDetailProps} onClose={onClose} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /back to expense list/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("T13: shows Approve button for submitted expense", () => {
    render(
      <MemoryRouter>
        <MobileAdminExpenseDetailView
          {...baseDetailProps}
          expense={makeExpense({ status: "submitted" })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /^approve$/i })).toBeInTheDocument();
  });
});

// ============================================================
// GROUP 4 — MobileTopBar — ?from=admin back navigation
// ============================================================

import { MobileTopBar } from "../MobileTopBar";

describe("MobileTopBar — batch review back navigation (from=admin)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("T14: batch review + ?from=admin shows back button and navigates to /admin/expenses", () => {
    mockLocationValue = {
      pathname: "/expenses/batch/abc123/review",
      search: "?from=admin&expense=exp-1",
    };
    render(
      <MemoryRouter>
        <MobileTopBar initials="AS" onAvatarPress={() => undefined} />
      </MemoryRouter>,
    );
    const backBtn = screen.getByRole("button", { name: /go back/i });
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(mockNavigate).toHaveBeenCalledWith("/admin/expenses");
  });
});
