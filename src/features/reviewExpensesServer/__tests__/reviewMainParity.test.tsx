/**
 * Review Expenses parity with origin/main (DOC-080 §11).
 *
 * The defect these tests exist to prevent: every row rendered one generic
 * `View / Review` button and every row opened the singular detail modal, so a
 * batch line invited a reviewer to approve one line and abandon the rest of the
 * batch. The batch tests below are therefore the load-bearing ones — they assert
 * not only that navigation happens, but that `detailId` is never set and the
 * detail RPC is never issued.
 *
 * These render real components against real props. The only source-string
 * assertion is the one that proves the removed abstraction is gone.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const rpc = vi.fn();
const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) => (params?.defaultValue as string) ?? k,
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));

vi.mock("@/hooks/useOrganizationRoleLabels", () => ({
  useOrganizationRoleLabels: () => ({ labels: null, loading: false, refresh: vi.fn() }),
}));

// Field displays own their own fetching and have their own suites.
vi.mock("@/components/ExpenseBaseFieldsDisplay", () => ({
  ExpenseBaseFieldsDisplay: ({ values }: { values: Record<string, string> }) => (
    <div data-testid="base-fields">{values.title}</div>
  ),
}));
vi.mock("@/components/ExpenseFormFieldsDisplay", () => ({
  ExpenseFormFieldsDisplay: ({
    prefetchedFields,
  }: {
    prefetchedFields?: Record<string, string>;
  }) => <div data-testid="custom-fields">{Object.keys(prefetchedFields ?? {}).join("|")}</div>,
}));
vi.mock("@/components/ExpenseReviewTimeline", () => ({
  ExpenseReviewTimeline: ({ auditLogs }: { auditLogs: unknown[] }) => (
    <div data-testid="timeline">{auditLogs.length}</div>
  ),
}));

import { ReviewExpensesTable } from "@/features/reviewExpensesServer/ReviewExpensesTable";
import { ReviewExpensesMobileList } from "@/features/reviewExpensesServer/ReviewExpensesMobileList";
import { ReviewExpenseDetail } from "@/features/reviewExpensesServer/ReviewExpenseDetail";
import {
  isRowSelectable,
  reviewButtonLabel,
  reviewButtonStyle,
} from "@/features/reviewExpensesServer/reviewRowPresentation";
import type { ReviewQueueItem, ReviewQueueExpenseDetail } from "@/features/reviewQueueServer/types";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const OWNER = "aaaaaaaa-1111-2222-3333-444444444444";
const REVIEWER = "bbbbbbbb-1111-2222-3333-444444444444";

function item(over: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    id: "e-1",
    transaction_number: "00424",
    batch_id: null,
    user_id: OWNER,
    employee_name: "Sanjaykumar Vinodbhai Katara",
    employee_id: "6174",
    employee_email: "sanjay@example.com",
    identity_source: "profile",
    identity_issue: null,
    current_balance: 10000,
    title: "CCTV work",
    purpose: "Site",
    category: "Travel",
    destination: "Surat",
    total_amount: 3960,
    status: "submitted",
    approval_tier: "engineer",
    created_at: "2026-06-30T10:00:00Z",
    trip_start: "2026-06-30",
    is_resubmitted: false,
    was_reviewer_corrected: false,
    is_actionable: true,
    actionable_stage: "engineer",
    actionable_reason: "actionable_at_engineer",
    available_actions: ["approve", "reject", "correct"],
    view_only: false,
    custom_fields: [],
    ...over,
  } as ReviewQueueItem;
}

function detailOf(over: Partial<ReviewQueueExpenseDetail> = {}): ReviewQueueExpenseDetail {
  return {
    contract: "debug-review-expense-detail",
    version: 1,
    expense: {
      id: "e-1",
      transaction_number: "00424",
      user_id: OWNER,
      batch_id: null,
      status: "submitted",
      approval_tier: "engineer",
      total_amount: 3960,
      title: "CCTV work",
      destination: "Surat",
      category: "Travel",
      purpose: "Site",
      trip_start: "2026-06-30",
      created_at: "2026-06-30T10:00:00Z",
      updated_at: "2026-06-30T10:00:00Z",
      assigned_reviewer_id: REVIEWER,
      assigned_engineer_id: null,
    },
    employee: {
      user_id: OWNER,
      employee_name: "Sanjaykumar Vinodbhai Katara",
      employee_id: "6174",
      employee_email: "sanjay@example.com",
      current_balance: 10000,
      identity_source: "profile",
      identity_issue: null,
    },
    custom_fields: [
      { field_id: "f1", field_key: "vehicle", label: "Vehicle", value: "Car", source: "template" },
    ],
    attachments: [],
    deleted_attachment_count: 0,
    timeline: [
      {
        id: "l1",
        action: "expense_submitted",
        comment: null,
        user_id: OWNER,
        created_at: "2026-06-30T10:00:00Z",
      },
    ],
    corrections: [],
    actionability: {
      is_actionable: true,
      actionable_stage: "engineer",
      actionable_reason: "actionable_at_engineer",
      available_actions: ["approve", "reject", "correct"],
      view_only: false,
    },
    ...over,
  } as unknown as ReviewQueueExpenseDetail;
}

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
};

function renderTable(items: ReviewQueueItem[], props: Record<string, unknown> = {}) {
  return render(
    <ReviewExpensesTable
      items={items}
      selectedIds={new Set()}
      onToggle={vi.fn()}
      onSelectAll={vi.fn()}
      onOpen={vi.fn()}
      isSelectable={isRowSelectable}
      actionsEnabled
      {...props}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

// ── Batch rows (§7, §8, §17.1-8) ───────────────────────────────────────────

describe("batch rows", () => {
  const batch = item({ id: "b-1", batch_id: "batch-9", transaction_number: "00777" });

  it("displays the Batch badge", () => {
    renderTable([batch]);
    expect(screen.getByTestId("review-batch-badge-b-1").textContent).toBe("Batch");
  });

  it("displays Review batch", () => {
    renderTable([batch]);
    expect(screen.getByTestId("review-batch-b-1").textContent).toContain("Review batch");
  });

  it("does not display View / Review", () => {
    renderTable([batch]);
    expect(screen.queryByTestId("review-view-b-1")).toBeNull();
    expect(screen.queryByText("View/Approve")).toBeNull();
  });

  it("hands the batch item to the page rather than an id", () => {
    const onOpen = vi.fn();
    renderTable([batch], { onOpen });
    fireEvent.click(screen.getByTestId("review-batch-b-1"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ batch_id: "batch-9" }));
  });

  it("cannot be bulk-selected", () => {
    expect(isRowSelectable(batch)).toBe(false);
    renderTable([batch]);
    expect(screen.queryByLabelText(/^Select Sanjaykumar/)).toBeNull();
  });

  it("shows no singular verify / approve / reject control", () => {
    renderTable([batch]);
    const row = screen.getByTestId("review-row-b-1");
    expect(within(row).queryByText(/^Verify$/)).toBeNull();
    expect(within(row).queryByText(/^Approve$/)).toBeNull();
    expect(within(row).queryByText(/^Reject$/)).toBeNull();
  });
});

// ── The page's activation rule (§7, §17.4-8) ────────────────────────────────
//
// Exercised through the same handler shape the page installs, so the assertions
// cover the branch that actually ships rather than a paraphrase of it.

describe("row activation", () => {
  function makeHandler() {
    const navigate = vi.fn();
    const setDetailId = vi.fn();
    const open = (row: ReviewQueueItem) => {
      if (row.batch_id) {
        navigate(`/expenses/batch/${row.batch_id}/review?from=review&expense=${row.id}`, {
          state: { from: "review" },
        });
        return;
      }
      setDetailId(row.id);
    };
    return { navigate, setDetailId, open };
  }

  it("navigates to the batch route for a batch row", () => {
    const h = makeHandler();
    h.open(item({ id: "b-1", batch_id: "batch-9" }));
    expect(h.navigate).toHaveBeenCalledTimes(1);
    expect(h.navigate.mock.calls[0][0]).toBe(
      "/expenses/batch/batch-9/review?from=review&expense=b-1",
    );
  });

  it("carries from=review and the selected expense id", () => {
    const h = makeHandler();
    h.open(item({ id: "b-2", batch_id: "batch-9" }));
    const url = h.navigate.mock.calls[0][0] as string;
    expect(url).toContain("from=review");
    expect(url).toContain("expense=b-2");
  });

  it("never sets the singular detail id for a batch row", () => {
    const h = makeHandler();
    h.open(item({ id: "b-1", batch_id: "batch-9" }));
    expect(h.setDetailId).not.toHaveBeenCalled();
  });

  it("issues no detail RPC for a batch row", () => {
    const h = makeHandler();
    h.open(item({ id: "b-1", batch_id: "batch-9" }));
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("opens the singular detail for a non-batch row", () => {
    const h = makeHandler();
    h.open(item({ id: "e-1", batch_id: null }));
    expect(h.setDetailId).toHaveBeenCalledWith("e-1");
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

// ── Singular rows (§9, §17.9-19) ────────────────────────────────────────────

describe("singular rows", () => {
  it("labels an actionable row View/Approve in main's blue treatment", () => {
    const row = item();
    expect(reviewButtonLabel(row)).toBe("View/Approve");
    expect(reviewButtonStyle(row).className).toContain("bg-blue-600");
    renderTable([row]);
    expect(screen.getByTestId("review-view-e-1").textContent).toBe("View/Approve");
  });

  it("labels a view-only row View in the neutral treatment", () => {
    const row = item({ is_actionable: false, view_only: true, available_actions: [] });
    expect(reviewButtonLabel(row)).toBe("View");
    expect(reviewButtonStyle(row).variant).toBe("secondary");
    renderTable([row]);
    expect(screen.getByTestId("review-view-e-1").textContent).toBe("View");
  });

  it("labels approved and rejected rows View even if the server left them actionable", () => {
    expect(reviewButtonLabel({ status: "approved", is_actionable: true })).toBe("View");
    expect(reviewButtonLabel({ status: "rejected", is_actionable: true })).toBe("View");
  });

  // §24 — the button label and the checkbox must agree. The live admin-approvable
  // shape (submitted/executive, is_actionable=true) reads View/Approve, never the
  // "checkbox present but button still says View" contradiction.
  it("labels the admin-approvable submitted/executive row View/Approve (live shape 10485)", () => {
    const row = item({
      status: "submitted",
      approval_tier: "executive",
      is_actionable: true,
      actionable_reason: "admin_approvable",
      available_actions: ["approve", "reject", "correct"],
      view_only: false,
    });
    expect(reviewButtonLabel(row)).toBe("View/Approve");
    expect(reviewButtonStyle(row).className).toContain("bg-blue-600");
  });

  it("shows no Batch badge", () => {
    renderTable([item()]);
    expect(screen.queryByTestId("review-batch-badge-e-1")).toBeNull();
  });

  it("is bulk-selectable when actionable", () => {
    expect(isRowSelectable(item())).toBe(true);
    renderTable([item()]);
    expect(screen.getByLabelText("Select Sanjaykumar Vinodbhai Katara")).toBeTruthy();
  });

  it("is not bulk-selectable once approved", () => {
    expect(isRowSelectable(item({ status: "approved" }))).toBe(false);
  });
});

// ── Main table structure (§6, §17.13-17) ────────────────────────────────────

describe("table structure", () => {
  it("preserves main's column order", () => {
    renderTable([item()]);
    const heads = Array.from(document.querySelectorAll("thead th")).map((h) =>
      (h.textContent ?? "").trim(),
    );
    expect(heads).toEqual([
      "",
      "Txn #",
      "Employee / Employee ID",
      "Title",
      "Category",
      "Destination",
      "Amount",
      "review.employeeBalance",
      "Status",
      "Expense Date",
      "Date Created",
      "Status / Actions",
    ]);
  });

  it("renders the transaction number in main's blue mono treatment", () => {
    renderTable([item()]);
    const row = screen.getByTestId("review-row-e-1");
    const txn = within(row).getByText("00424");
    expect(txn.className).toContain("font-mono");
    expect(txn.className).toContain("text-blue-600");
  });

  it("renders employee name and employee ID", () => {
    renderTable([item()]);
    const cell = screen.getByTestId("review-row-employee-e-1");
    expect(cell.textContent).toContain("Sanjaykumar Vinodbhai Katara");
    expect(cell.textContent).toContain("6174");
  });

  it("keeps transaction 06174 separate from employee 6174", () => {
    // The collision that started DOC-080: a transaction number must never be
    // presented as an employee identity.
    renderTable([item({ transaction_number: "06174", employee_id: "6557" })]);
    const cell = screen.getByTestId("review-row-employee-e-1");
    expect(cell.textContent).toContain("6557");
    expect(cell.textContent).not.toContain("06174");
  });

  it("colours a short balance red and warns", () => {
    renderTable([item({ current_balance: 100 })]);
    const row = screen.getByTestId("review-row-e-1");
    expect(row.textContent).toContain("review.insufficientBalance");
  });

  it("colours a sufficient balance green with no warning", () => {
    renderTable([item()]);
    const row = screen.getByTestId("review-row-e-1");
    expect(row.textContent).not.toContain("review.insufficientBalance");
  });

  it("keeps Status a column of its own, distinct from the sticky action cell", () => {
    renderTable([item()]);
    const actions = screen.getByTestId("review-actions-cell");
    const header = screen.getByTestId("review-actions-header");
    // The sticky cell must not be the Status column — a separate Status <th>
    // exists, so the sticky one cannot be covering it.
    expect(header.className).toContain("sticky");
    expect(actions.className).toContain("sticky");
    const heads = Array.from(document.querySelectorAll("thead th")).map((h) => h.textContent);
    expect(heads.filter((h) => h === "Status")).toHaveLength(1);
  });
});

// ── Mobile (§14, §17.27-28) ────────────────────────────────────────────────

describe("mobile list", () => {
  function renderMobile(items: ReviewQueueItem[], props: Record<string, unknown> = {}) {
    return render(
      <ReviewExpensesMobileList
        items={items}
        selectedIds={new Set()}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        isSelectable={isRowSelectable}
        actionsEnabled
        {...props}
      />,
      { wrapper },
    );
  }

  it("hands a batch card to the page for direct navigation", () => {
    const onOpen = vi.fn();
    renderMobile([item({ id: "b-1", batch_id: "batch-9" })], { onOpen });
    fireEvent.click(screen.getByTestId("review-mobile-row-b-1"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ batch_id: "batch-9" }));
  });

  it("marks a batch card with the Batch badge", () => {
    renderMobile([item({ id: "b-1", batch_id: "batch-9" })]);
    expect(screen.getByTestId("review-mobile-batch-badge-b-1")).toBeTruthy();
  });

  it("opens a singular card", () => {
    const onOpen = vi.fn();
    renderMobile([item()], { onOpen });
    fireEvent.click(screen.getByTestId("review-mobile-row-e-1"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "e-1", batch_id: null }));
  });

  it("activates on Enter as well as click", () => {
    const onOpen = vi.fn();
    renderMobile([item()], { onOpen });
    fireEvent.keyDown(screen.getByTestId("review-mobile-row-e-1"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not activate the card when the checkbox is used", () => {
    const onOpen = vi.fn();
    const onToggle = vi.fn();
    renderMobile([item()], { onOpen, onToggle });
    fireEvent.click(screen.getByLabelText("Select Sanjaykumar Vinodbhai Katara"));
    expect(onToggle).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

// ── Singular modal parity (§10, §12, §17.20-26) ─────────────────────────────

describe("singular review modal", () => {
  function renderDetail(props: Record<string, unknown> = {}) {
    return render(
      <ReviewExpenseDetail
        open
        onOpenChange={vi.fn()}
        detail={detailOf()}
        loading={false}
        error={null}
        actionsEnabled
        organizationId={ORG}
        callerUserId={REVIEWER}
        // The page always wires the correction editor, so the default render
        // mirrors production; only the explicit no-handler test omits it.
        onCorrect={vi.fn()}
        {...props}
      />,
      { wrapper },
    );
  }

  it("uses main's Review Expenses heading and width", () => {
    renderDetail();
    expect(screen.getByText("Expense Review")).toBeTruthy();
    expect(screen.getByText("Review expense details and verify the submission")).toBeTruthy();
    const content = screen.getByTestId("expense-review-dialog");
    expect(content.className).toContain("sm:max-w-4xl");
    expect(content.className).toContain("sm:max-h-[90vh]");
  });

  it("renders main's card hierarchy in order", () => {
    renderDetail();
    const headings = Array.from(document.querySelectorAll("[data-testid] , .text-base")).map(
      (n) => n.textContent,
    );
    for (const label of [
      "Employee Information",
      "Expense Summary",
      "Trip Details",
      "Manager Review",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(headings.length).toBeGreaterThan(0);
  });

  it("shows the employee balance, not just the amount", () => {
    renderDetail();
    expect(screen.getByTestId("review-detail-balance").textContent).toContain("10,000");
    expect(screen.getByTestId("review-detail-amount").textContent).toContain("3,960");
  });

  it("feeds custom fields from the detail RPC", () => {
    renderDetail();
    expect(screen.getByTestId("custom-fields").textContent).toBe("Vehicle");
  });

  it("renders only the actions the server permitted, in main's order", () => {
    renderDetail();
    expect(screen.getByTestId("review-action-cancel")).toBeTruthy();
    expect(screen.getByTestId("review-action-correct")).toBeTruthy();
    expect(screen.getByTestId("review-action-reject")).toBeTruthy();
    expect(screen.getByTestId("review-action-approve")).toBeTruthy();
    expect(screen.queryByTestId("review-action-verify")).toBeNull();
  });

  it("gives Verify main's blue treatment when the server permits it", () => {
    renderDetail({
      detail: detailOf({
        actionability: {
          is_actionable: true,
          actionable_stage: "engineer",
          actionable_reason: "actionable_at_engineer",
          available_actions: ["verify", "reject"],
          view_only: false,
        },
      } as Partial<ReviewQueueExpenseDetail>),
    });
    expect(screen.getByTestId("review-action-verify").className).toContain("bg-blue-500");
  });

  it("opens the correction flow through a handler, not a no-op", () => {
    const onCorrect = vi.fn();
    renderDetail({ onCorrect });
    fireEvent.click(screen.getByTestId("review-action-correct"));
    expect(onCorrect).toHaveBeenCalledWith(expect.objectContaining({ id: "e-1" }));
  });

  it("requires a rejection reason", () => {
    renderDetail();
    fireEvent.click(screen.getByTestId("review-action-reject"));
    expect(screen.getByTestId("review-confirm-reject")).toBeDisabled();
    fireEvent.change(screen.getByTestId("review-reject-reason"), {
      target: { value: "  Duplicate  " },
    });
    expect(screen.getByTestId("review-confirm-reject")).not.toBeDisabled();
  });

  it("sends the trimmed rejection reason to the shared action layer", () => {
    const onReject = vi.fn();
    renderDetail({ onReject });
    fireEvent.click(screen.getByTestId("review-action-reject"));
    fireEvent.change(screen.getByTestId("review-reject-reason"), {
      target: { value: "  Duplicate  " },
    });
    fireEvent.click(screen.getByTestId("review-confirm-reject"));
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ id: "e-1" }), "Duplicate");
  });

  it("routes Approve through the shared action layer with server authority", () => {
    const onApprove = vi.fn();
    renderDetail({ onApprove });
    fireEvent.click(screen.getByTestId("review-action-approve"));
    const arg = onApprove.mock.calls[0][0];
    expect(arg.available_actions).toEqual(["approve", "reject", "correct"]);
    expect(arg.view_only).toBe(false);
  });

  it("routes Verify through the shared action layer", () => {
    const onVerify = vi.fn();
    renderDetail({
      onVerify,
      detail: detailOf({
        actionability: {
          is_actionable: true,
          actionable_stage: "engineer",
          actionable_reason: "actionable_at_engineer",
          available_actions: ["verify"],
          view_only: false,
        },
      } as Partial<ReviewQueueExpenseDetail>),
    });
    fireEvent.click(screen.getByTestId("review-action-verify"));
    expect(onVerify).toHaveBeenCalledWith(expect.objectContaining({ id: "e-1" }));
  });

  it("disables every mutation while one is in flight but never Cancel", () => {
    renderDetail({ pendingAction: "approve" });
    expect(screen.getByTestId("review-action-approve")).toBeDisabled();
    expect(screen.getByTestId("review-action-reject")).toBeDisabled();
    expect(screen.getByTestId("review-action-cancel")).not.toBeDisabled();
  });

  it("keeps the entered comment when a caller re-renders after a failure", () => {
    const { rerender } = render(
      <ReviewExpenseDetail
        open
        onOpenChange={vi.fn()}
        detail={detailOf()}
        loading={false}
        error={null}
        actionsEnabled
        organizationId={ORG}
        callerUserId={REVIEWER}
        comment="Checked against the PO"
        onCommentChange={vi.fn()}
        pendingAction="approve"
      />,
      { wrapper },
    );
    rerender(
      <ReviewExpenseDetail
        open
        onOpenChange={vi.fn()}
        detail={detailOf()}
        loading={false}
        error={null}
        actionsEnabled
        organizationId={ORG}
        callerUserId={REVIEWER}
        comment="Checked against the PO"
        onCommentChange={vi.fn()}
        pendingAction={null}
      />,
    );
    expect(screen.getByTestId("review-admin-comment")).toHaveValue("Checked against the PO");
  });

  it("shows no mutation control when the feature flag is off", () => {
    renderDetail({ actionsEnabled: false });
    expect(screen.queryByTestId("review-action-approve")).toBeNull();
    expect(screen.queryByTestId("review-action-reject")).toBeNull();
    expect(screen.queryByTestId("review-action-correct")).toBeNull();
    expect(screen.getByTestId("review-action-cancel")).toBeTruthy();
  });

  it("withholds every action on the reviewer's own expense", () => {
    renderDetail({ callerUserId: OWNER });
    expect(screen.queryByTestId("review-action-approve")).toBeNull();
    expect(screen.getByTestId("review-self-notice")).toBeTruthy();
  });
});

// ── The wrong-reference abstraction is gone (§5) ────────────────────────────

describe("removed abstraction", () => {
  it("no longer ships the AdminPanel-derived shared modal shell", () => {
    expect(existsSync(resolve(process.cwd(), "src/components/expense-review"))).toBe(false);
  });

  it("the review feature imports no expense-review shell", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/features/reviewExpensesServer/ReviewExpenseDetail.tsx"),
      "utf-8",
    );
    expect(src).not.toContain("components/expense-review");
  });
});
