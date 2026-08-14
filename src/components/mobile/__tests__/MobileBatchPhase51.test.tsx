/**
 * Phase 5.1 tests:
 * A. Batch shared (allow-once) fields — lib logic
 * B. MobileTopBar back navigation for batch review
 * C. MobileBatchReviewView batch overview structure
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";

// --- Shared mocks ---

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => Promise.resolve({ data: [], error: null })),
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
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

vi.mock("@/lib/pageTitle", () => ({
  getPageTitle: () => "Test Page",
}));

// --- MobileTopBar navigate mock ---

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

// ============================================================
// GROUP 1 — splitAssignmentsByBatchMode (pure lib logic)
// ============================================================

import {
  splitAssignmentsByBatchMode,
  applyBatchFieldsToLines,
  uniqueCategoriesInLines,
  type CategoryAssignmentRow,
} from "@/lib/batchFormFields";
import type { BatchLineInput } from "@/lib/expenseBatchValidation";

describe("splitAssignmentsByBatchMode", () => {
  it("T1: ask_once_per_batch=true field goes to batchOnce", () => {
    const fields: CategoryAssignmentRow[] = [{ ask_once_per_batch: true, show_on_submit: true }];
    const { batchOnce, perLine } = splitAssignmentsByBatchMode(fields);
    expect(batchOnce).toHaveLength(1);
    expect(perLine).toHaveLength(0);
  });

  it("T2: ask_once_per_batch=false field goes to perLine", () => {
    const fields: CategoryAssignmentRow[] = [{ ask_once_per_batch: false, show_on_submit: true }];
    const { batchOnce, perLine } = splitAssignmentsByBatchMode(fields);
    expect(batchOnce).toHaveLength(0);
    expect(perLine).toHaveLength(1);
  });

  it("T3: undefined ask_once_per_batch goes to perLine", () => {
    const fields: CategoryAssignmentRow[] = [{ show_on_submit: true }];
    const { batchOnce, perLine } = splitAssignmentsByBatchMode(fields);
    expect(batchOnce).toHaveLength(0);
    expect(perLine).toHaveLength(1);
  });

  it("T4: show_on_submit=false field excluded from both batchOnce and perLine", () => {
    const fields: CategoryAssignmentRow[] = [
      { ask_once_per_batch: true, show_on_submit: false },
      { ask_once_per_batch: false, show_on_submit: false },
    ];
    const { batchOnce, perLine } = splitAssignmentsByBatchMode(fields);
    expect(batchOnce).toHaveLength(0);
    expect(perLine).toHaveLength(0);
  });

  it("T5: mixed fields correctly split into batchOnce and perLine", () => {
    const fields: CategoryAssignmentRow[] = [
      { ask_once_per_batch: true, show_on_submit: true },
      { ask_once_per_batch: false, show_on_submit: true },
      { ask_once_per_batch: true, show_on_submit: true },
      { ask_once_per_batch: false, show_on_submit: false },
    ];
    const { batchOnce, perLine } = splitAssignmentsByBatchMode(fields);
    expect(batchOnce).toHaveLength(2);
    expect(perLine).toHaveLength(1);
  });
});

// ============================================================
// GROUP 2 — applyBatchFieldsToLines + uniqueCategoriesInLines
// ============================================================

describe("applyBatchFieldsToLines", () => {
  it("T6: merges batch-level fields into matching-category line", () => {
    const lines: BatchLineInput[] = [
      { clientId: "l1", title: "Trip", amount: 100, category: "travel", destination: "", purpose: "", tempReceiptFilenames: [] },
    ];
    const batchFields = { travel: { project_code: "PROJ-1" } };
    const result = applyBatchFieldsToLines(lines, batchFields);
    expect(result[0].formFieldValues).toEqual({ project_code: "PROJ-1" });
  });

  it("T7: leaves line unchanged when no batch fields for its category", () => {
    const lines: BatchLineInput[] = [
      { clientId: "l1", title: "Meal", amount: 200, category: "meals", destination: "", purpose: "", tempReceiptFilenames: [] },
    ];
    const batchFields = { travel: { project_code: "PROJ-1" } };
    const result = applyBatchFieldsToLines(lines, batchFields);
    expect(result[0]).toEqual(lines[0]);
  });
});

describe("uniqueCategoriesInLines", () => {
  it("T8: returns unique non-blank categories", () => {
    const lines: BatchLineInput[] = [
      { clientId: "l1", title: "A", amount: 0, category: "travel", destination: "", purpose: "", tempReceiptFilenames: [] },
      { clientId: "l2", title: "B", amount: 0, category: "travel", destination: "", purpose: "", tempReceiptFilenames: [] },
      { clientId: "l3", title: "C", amount: 0, category: "meals", destination: "", purpose: "", tempReceiptFilenames: [] },
      { clientId: "l4", title: "D", amount: 0, category: "", destination: "", purpose: "", tempReceiptFilenames: [] },
    ];
    const cats = uniqueCategoriesInLines(lines);
    expect(cats).toEqual(["travel", "meals"]);
  });
});

// ============================================================
// GROUP 3 — MobileTopBar back navigation for batch review
// ============================================================

import { MobileTopBar } from "../MobileTopBar";

describe("MobileTopBar — batch review back navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("T9: batch review URL with ?from=review shows back button and navigates to /review", () => {
    mockLocationValue = {
      pathname: "/expenses/batch/abc123/review",
      search: "?from=review",
    };
    render(
      <MemoryRouter>
        <MobileTopBar initials="AB" onAvatarPress={() => undefined} />
      </MemoryRouter>,
    );
    const backBtn = screen.getByRole("button", { name: /go back/i });
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(mockNavigate).toHaveBeenCalledWith("/review");
  });

  it("T10: batch review URL with no from param navigates to /expenses", () => {
    mockLocationValue = {
      pathname: "/expenses/batch/abc123/review",
      search: "",
    };
    render(
      <MemoryRouter>
        <MobileTopBar initials="AB" onAvatarPress={() => undefined} />
      </MemoryRouter>,
    );
    const backBtn = screen.getByRole("button", { name: /go back/i });
    fireEvent.click(backBtn);
    expect(mockNavigate).toHaveBeenCalledWith("/expenses");
  });

  it("T11: /review URL has no back button (returns null from getBackTarget)", () => {
    mockLocationValue = { pathname: "/review", search: "" };
    render(
      <MemoryRouter>
        <MobileTopBar initials="AB" onAvatarPress={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("button", { name: /go back/i })).toBeNull();
  });
});

// ============================================================
// GROUP 4 — MobileBatchReviewView batch overview structure
// ============================================================

import { MobileBatchReviewView } from "../MobileBatchReviewView";
import type { BatchReviewExpenseRow, BatchReviewRole } from "@/lib/batchExpenseReview";
import type { BatchExpenseReviewBatchInfo } from "@/components/BatchExpenseReviewPanel";

const makeBatch = (): BatchExpenseReviewBatchInfo => ({
  id: "batch-1",
  label: "Q3 Travel",
  shared_category: "travel",
  shared_expense_date: "2026-07-01",
  line_count: 3,
  total_amount: 15000,
  created_at: "2026-07-01T10:00:00Z",
  user_id: "u1",
});

const makeExp = (overrides: Partial<BatchReviewExpenseRow> = {}): BatchReviewExpenseRow => ({
  id: "e1",
  title: "Hotel Stay",
  category: "travel",
  purpose: "Conference",
  destination: "Mumbai",
  trip_start: "2026-07-01",
  total_amount: 5000,
  status: "submitted",
  transaction_number: "TXN-001",
  user_id: "u1",
  user_name: "Alice",
  user_email: "alice@example.com",
  wasReviewerCorrected: false,
  ...overrides,
});

describe("MobileBatchReviewView — Phase 5.1 batch overview", () => {
  it("T12: renders batch label in the summary card", () => {
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[]}
          submitterName="Bob"
          role={"engineer" as BatchReviewRole}
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Q3 Travel")).toBeInTheDocument();
  });

  it("T13: renders submitter name in the summary card description", () => {
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[]}
          submitterName="Bob Smith"
          role={"engineer" as BatchReviewRole}
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Bob Smith/)).toBeInTheDocument();
  });

  it("T14: renders one card per expense", () => {
    const expenses = [makeExp({ id: "e1" }), makeExp({ id: "e2", title: "Flight" })];
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={expenses}
          submitterName="Bob"
          role={"engineer" as BatchReviewRole}
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("T15: calls onSelectExpense with the correct expense when tapped", () => {
    const onSelect = vi.fn();
    const expense = makeExp();
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[expense]}
          submitterName="Bob"
          role={"engineer" as BatchReviewRole}
          onSelectExpense={onSelect}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(expense);
  });

  it("T16: has no table element and uses mobile-batch-line-card class", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[makeExp()]}
          submitterName="Bob"
          role={"engineer" as BatchReviewRole}
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".mobile-batch-line-card")).toBeInTheDocument();
  });

  it("T17: shows empty-state message when expenses array is empty", () => {
    render(
      <MemoryRouter>
        <MobileBatchReviewView
          batch={makeBatch()}
          expenses={[]}
          submitterName="Bob"
          role={"engineer" as BatchReviewRole}
          onSelectExpense={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No expenses in this batch/)).toBeInTheDocument();
  });
});
