import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// --- Mocks ---

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
    })),
  },
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    userRole: "engineer",
    organizationId: "org1",
    organizationFeatureFlags: {},
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }),
}));

vi.mock("@/i18n", () => ({
  useTranslation: (_ns?: string | string[]) => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") return `${k}:${JSON.stringify(opts)}`;
      return k;
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("@/components/ExpenseStatusWithCorrectionBadge", () => ({
  ExpenseStatusWithCorrectionBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

vi.mock("@/components/BatchExpenseDetailCard", () => ({
  BatchExpenseDetailCard: ({ expense }: { expense: { title: string } }) => (
    <div data-testid="batch-detail-card">{expense.title}</div>
  ),
}));

vi.mock("@/components/ExpenseCategorySelect", () => ({
  ExpenseCategorySelect: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <select
      data-testid="category-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="travel">Travel</option>
    </select>
  ),
}));

// --- Types / Helpers ---

import type { BatchReviewExpenseRow } from "@/lib/batchExpenseReview";

const makeExpense = (overrides: Partial<BatchReviewExpenseRow> = {}): BatchReviewExpenseRow => ({
  id: "exp-1",
  title: "Office Supplies",
  category: "office",
  purpose: "Q2 stationery",
  destination: "Mumbai",
  trip_start: "2026-07-01",
  total_amount: 3500,
  status: "submitted",
  transaction_number: "TXN-001",
  user_id: "u1",
  user_name: "Alice",
  user_email: "alice@example.com",
  wasReviewerCorrected: false,
  ...overrides,
});

// --- MobileBatchLineCard ---

import { MobileBatchLineCard } from "../MobileBatchLineCard";

describe("MobileBatchLineCard", () => {
  it("T1: renders title, amount and status", () => {
    const expense = makeExpense();
    render(
      <MemoryRouter>
        <MobileBatchLineCard expense={expense} onSelect={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Office Supplies")).toBeInTheDocument();
    expect(screen.getByText(/3,500/)).toBeInTheDocument();
    expect(screen.getByTestId("status-badge")).toHaveTextContent("submitted");
  });

  it("T2: calls onSelect when tapped", () => {
    const onSelect = vi.fn();
    const expense = makeExpense();
    render(
      <MemoryRouter>
        <MobileBatchLineCard expense={expense} onSelect={onSelect} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("T3: shows category when present", () => {
    render(
      <MemoryRouter>
        <MobileBatchLineCard expense={makeExpense({ category: "travel" })} onSelect={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByText("travel")).toBeInTheDocument();
  });

  it("T4: shows transaction number when present", () => {
    render(
      <MemoryRouter>
        <MobileBatchLineCard expense={makeExpense({ transaction_number: "TXN-999" })} onSelect={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.getByText("#TXN-999")).toBeInTheDocument();
  });
});

// --- MobileBatchReviewView ---

import { MobileBatchReviewView } from "../MobileBatchReviewView";
import type { BatchExpenseReviewBatchInfo } from "@/components/BatchExpenseReviewPanel";

const makeBatch = (): BatchExpenseReviewBatchInfo => ({
  id: "batch-1",
  label: "July Expenses",
  shared_category: "travel",
  shared_expense_date: "2026-07-01",
  line_count: 3,
  total_amount: 12000,
  created_at: "2026-07-01T10:00:00Z",
  user_id: "u1",
});

describe("MobileBatchReviewView", () => {
  it("T5: renders batch label and total", () => {
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[]}
          submitterName="Alice"
          role="engineer"
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("July Expenses")).toBeInTheDocument();
    expect(screen.getByText(/12,000/)).toBeInTheDocument();
  });

  it("T6: renders one card per expense", () => {
    const expenses = [makeExpense({ id: "e1" }), makeExpense({ id: "e2", title: "Lunch" })];
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={expenses}
          submitterName="Alice"
          role="engineer"
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("T7: empty state when no expenses", () => {
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[]}
          submitterName="Alice"
          role="engineer"
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No expenses in this batch/)).toBeInTheDocument();
  });

  it("T8: calls onSelectExpense when card is tapped", () => {
    const onSelect = vi.fn();
    const expense = makeExpense();
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[expense]}
          submitterName="Alice"
          role="engineer"
          onSelectExpense={onSelect}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(expense);
  });

  it("T9: shows pending count when some not reviewed", () => {
    const expenses = [
      makeExpense({ id: "e1", status: "submitted" }),
      makeExpense({ id: "e2", status: "approved" }),
    ];
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={expenses}
          submitterName="Alice"
          role="engineer"
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("1")).toBeInTheDocument(); // pending count
  });

  it("T10: uses no table element on mobile — card list only", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[makeExpense()]}
          submitterName="Alice"
          role="engineer"
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".mobile-batch-line-card")).toBeInTheDocument();
  });
});

// --- MobileBatchReviewActionBar ---

import { MobileBatchReviewActionBar } from "../MobileBatchReviewActionBar";

describe("MobileBatchReviewActionBar", () => {
  const noop = () => undefined;

  it("T11: shows Approve button when canApprove", () => {
    render(
      <MobileBatchReviewActionBar
        actionLoading={null}
        canVerify={false}
        canApprove={true}
        canReject={true}
        canCorrect={true}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /verify/i })).toBeNull();
  });

  it("T12: shows Verify button when !canApprove", () => {
    render(
      <MobileBatchReviewActionBar
        actionLoading={null}
        canVerify={true}
        canApprove={false}
        canReject={false}
        canCorrect={false}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /verify/i })).toBeInTheDocument();
  });

  it("T13: hides Correct button when correctionOpen", () => {
    render(
      <MobileBatchReviewActionBar
        actionLoading={null}
        canVerify={false}
        canApprove={false}
        canReject={true}
        canCorrect={true}
        correctionOpen={true}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: /correct/i })).toBeNull();
  });

  it("T14: shows loading spinner when actionLoading is set", () => {
    render(
      <MobileBatchReviewActionBar
        actionLoading="approve"
        canVerify={false}
        canApprove={true}
        canReject={true}
        canCorrect={true}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    expect(screen.getByText(/Processing/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("T15: has .mobile-batch-action-bar class (no fixed positioning)", () => {
    const { container } = render(
      <MobileBatchReviewActionBar
        actionLoading={null}
        canVerify={false}
        canApprove={true}
        canReject={true}
        canCorrect={false}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    const bar = container.querySelector(".mobile-batch-action-bar");
    expect(bar).toBeInTheDocument();
    const style = bar ? window.getComputedStyle(bar) : null;
    expect(style?.position).not.toBe("fixed");
  });
});

// --- MobileBatchLineDetail ---

import { MobileBatchLineDetail } from "../MobileBatchLineDetail";

const detailDefaults = {
  organizationId: "org1",
  role: "engineer" as const,
  actionLoading: null,
  canVerify: true,
  canApprove: false,
  canReject: true,
  correctionDialogOpen: false,
  correctionLoading: false,
  corrTitle: "Office Supplies",
  setCorrTitle: vi.fn(),
  corrDestination: "Mumbai",
  setCorrDestination: vi.fn(),
  corrExpenseDate: "2026-07-01",
  setCorrExpenseDate: vi.fn(),
  corrPurpose: "Q2",
  setCorrPurpose: vi.fn(),
  corrCategory: "office",
  setCorrCategory: vi.fn(),
  corrAmount: "3500",
  setCorrAmount: vi.fn(),
  corrReason: "",
  setCorrReason: vi.fn(),
  reviewComment: "",
  setReviewComment: vi.fn(),
  onBack: vi.fn(),
  onVerify: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onCorrect: vi.fn(),
  onSubmitCorrection: vi.fn(),
  onCancelCorrection: vi.fn(),
};

describe("MobileBatchLineDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("T16: renders detail card for the expense", () => {
    render(
      <MemoryRouter>
        <MobileBatchLineDetail expense={makeExpense()} {...detailDefaults} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("batch-detail-card")).toHaveTextContent("Office Supplies");
  });

  it("T17: inline correction panel hidden by default", () => {
    render(
      <MemoryRouter>
        <MobileBatchLineDetail expense={makeExpense()} {...detailDefaults} correctionDialogOpen={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Correct this expense")).toBeNull();
  });

  it("T18: inline correction panel shown when correctionDialogOpen=true", () => {
    render(
      <MemoryRouter>
        <MobileBatchLineDetail
          expense={makeExpense()}
          {...detailDefaults}
          correctionDialogOpen={true}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Correct this expense")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect(screen.getByLabelText("Reason for correction (audit)")).toBeInTheDocument();
  });
});
