import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileReviewQueueView } from "../MobileReviewQueueView";
import { MobileReviewExpenseCard } from "../MobileReviewExpenseCard";
import { MobileReviewDetailView } from "../MobileReviewDetailView";
import { MobileReviewActionBar } from "../MobileReviewActionBar";
import type { Expense } from "@/pages/EngineerReview";
import { supabase } from "@/integrations/supabase/client";
import { EMPTY_CORRECTION_FIELDS } from "@/lib/loadCorrectionCustomFields";

// ── Shared mocks ──────────────────────────────────────────────────────────────

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    userRole: "engineer",
    isAccountantCashier: false,
    userProfile: { name: "Reviewer" },
    signOut: vi.fn(),
    organizationFeatureFlags: {},
    isTenantHost: false,
    tenantHostOrgId: null,
    organizationId: "org-1",
    user: { id: "rev-1" },
    session: null,
    hasOrganizationFeature: vi.fn(() => false),
  })),
}));

vi.mock("@/hooks/useAllowCashierExpenseSubmission", () => ({
  useAllowCashierExpenseSubmission: () => ({ allowCashierExpenseSubmission: null }),
}));

vi.mock("@/hooks/usePendingTransferOfferCount", () => ({
  usePendingTransferOfferCount: () => ({ count: 0, enabled: false, refresh: vi.fn() }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: vi.fn(() => vi.fn()) };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ data: [], error: null })) })),
    })),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ExpenseStatusWithCorrectionBadge", () => ({
  ExpenseStatusWithCorrectionBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

vi.mock("@/components/ExpenseFormFieldsDisplay", () => ({
  ExpenseFormFieldsDisplay: () => <div data-testid="custom-fields" />,
}));

vi.mock("@/components/ExpenseReviewTimeline", () => ({
  ExpenseReviewTimeline: () => <div data-testid="timeline" />,
}));

vi.mock("@/components/ExpenseCorrectionAudit", () => ({
  ExpenseCorrectionAuditList: () => <div data-testid="correction-audit" />,
}));

vi.mock("@/components/ExpenseCategorySelect", () => ({
  ExpenseCategorySelect: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid="category-select">
      <option value="">—</option>
      <option value="travel">Travel</option>
    </select>
  ),
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

// ── Shared test data ──────────────────────────────────────────────────────────

const baseExpense: Expense = {
  id: "exp-1",
  title: "Client Visit Mumbai",
  destination: "Mumbai",
  trip_start: "2026-06-15",
  trip_end: "2026-06-15",
  status: "submitted",
  total_amount: 12500,
  created_at: "2026-06-15T10:00:00Z",
  user_id: "emp-1",
  user_name: "Rahul Sharma",
  user_email: "rahul@company.com",
  user_employee_id: "EMP001",
  user_balance: 50000,
  purpose: "Meet key client",
  category: "travel",
};

const formatSubline = (exp: Expense) => exp.user_employee_id ?? exp.user_email;

const noop = () => {};
const noopAsync = async () => {};

// ── Test 5: Mobile queue renders supplied review items ────────────────────────

describe("5 — MobileReviewQueueView renders supplied expense cards", () => {
  it("renders a card for each expense in the list", () => {
    const expenses: Expense[] = [
      baseExpense,
      { ...baseExpense, id: "exp-2", title: "Delhi Conference", user_name: "Priya Patel" },
    ];
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={expenses}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => true}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Client Visit Mumbai")).toBeInTheDocument();
    expect(screen.getByText("Delhi Conference")).toBeInTheDocument();
    expect(screen.getByText("2 expenses")).toBeInTheDocument();
  });

  it("calls onSelectExpense with the clicked expense", () => {
    const onSelectExpense = vi.fn();
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[baseExpense]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={onSelectExpense}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /client visit mumbai/i }));
    expect(onSelectExpense).toHaveBeenCalledWith(baseExpense);
  });
});

// ── Test 6: Batch indicator ───────────────────────────────────────────────────

describe("6 — MobileReviewExpenseCard batch indicator", () => {
  it("shows Batch badge when expense has batch_id", () => {
    render(
      <MobileReviewExpenseCard
        expense={{ ...baseExpense, batch_id: "batch-abc" }}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("Batch")).toBeInTheDocument();
  });

  it("does NOT show Batch badge when batch_id is null", () => {
    render(
      <MobileReviewExpenseCard
        expense={{ ...baseExpense, batch_id: null }}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.queryByText("Batch")).not.toBeInTheDocument();
  });
});

// ── Test 6b: 3-state parity badges (ready / waiting / completed) — §3 ─────────

describe("6b — MobileReviewExpenseCard 3-state parity badges", () => {
  it("ready (pending, not terminal) shows blue 'Action needed', no 'Waiting'", () => {
    render(
      <MobileReviewExpenseCard
        expense={{ ...baseExpense, status: "submitted" }}
        isPending
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("Action needed")).toBeInTheDocument();
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();
  });

  it("waiting (visible, not pending, not terminal) shows amber 'Waiting', no 'Action needed'", () => {
    // A Manager viewing an executive-tier row: visible but not yet actionable.
    render(
      <MobileReviewExpenseCard
        expense={{ ...baseExpense, status: "level_2_verified" }}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    const waiting = screen.getByText("Waiting");
    expect(waiting).toBeInTheDocument();
    expect(waiting.className).toContain("bg-amber-500");
    expect(screen.queryByText("Action needed")).not.toBeInTheDocument();
  });

  it("completed (terminal) shows neither 'Waiting' nor 'Action needed'", () => {
    render(
      <MobileReviewExpenseCard
        expense={{ ...baseExpense, status: "approved" }}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.queryByText("Waiting")).not.toBeInTheDocument();
    expect(screen.queryByText("Action needed")).not.toBeInTheDocument();
  });
});

// ── Test 7: Resubmitted / corrected indicator ─────────────────────────────────

describe("7 — MobileReviewExpenseCard resubmitted/corrected indicator", () => {
  it("shows Resubmitted badge when isResubmitted is true", () => {
    const expense = { ...baseExpense } as Expense & { isResubmitted?: boolean };
    expense.isResubmitted = true;
    render(
      <MobileReviewExpenseCard
        expense={expense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("Resubmitted")).toBeInTheDocument();
  });

  it("does NOT show Resubmitted badge when isResubmitted is false", () => {
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.queryByText("Resubmitted")).not.toBeInTheDocument();
  });
});

// ── Test 8: Mobile queue states ───────────────────────────────────────────────

describe("8 — MobileReviewQueueView loading / empty / filter states", () => {
  it("shows skeleton placeholders when loading=true", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[]}
          loading={true}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    // Skeleton elements present
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no expenses and no filters", () => {
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("No expenses assigned to you.")).toBeInTheDocument();
  });

  it("shows filter empty state when search is active but no results", () => {
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[]}
          loading={false}
          searchTerm="xyz-no-match"
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("No expenses match the current filters.")).toBeInTheDocument();
  });

  it("shows warning banner when managerFetchWarning is set", () => {
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning="Showing partial results — pagination limit reached."
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/partial results/i)).toBeInTheDocument();
  });

  it("§43: renders the Month selector, defaulting to 'All months' when the prop is omitted", () => {
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Month")).toBeInTheDocument();
    expect(screen.getByText("All months")).toBeInTheDocument();
  });

  it("§43: an exact month with zero rows shows the month-specific empty state, not the generic one", () => {
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          expenseMonth="2026-08"
          monthOptions={[
            { value: "all", label: "All months" },
            { value: "2026-08", label: "August 2026" },
          ]}
          onExpenseMonthChange={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("No review expenses found for August 2026.")).toBeInTheDocument();
    expect(screen.queryByText("No expenses assigned to you.")).not.toBeInTheDocument();
  });

  it("§43: selecting a month calls onExpenseMonthChange with the machine value", () => {
    const onExpenseMonthChange = vi.fn();
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          expenseMonth="all"
          monthOptions={[
            { value: "all", label: "All months" },
            { value: "2026-08", label: "August 2026" },
          ]}
          onExpenseMonthChange={onExpenseMonthChange}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText("Month"));
    fireEvent.click(screen.getByText("August 2026"));
    expect(onExpenseMonthChange).toHaveBeenCalledWith("2026-08");
  });
});

// ── Test 9: Mobile detail renders expense fields ──────────────────────────────

describe("9 — MobileReviewDetailView renders expense fields without extra fetch", () => {
  const detailProps = {
    expense: baseExpense,
    attachments: [],
    lineItems: [],
    auditLogs: [],
    correctionLogs: [],
    timelineAssignees: {},
    engineerComment: "",
    setEngineerComment: noop,
    reviewLoading: false,
    canApprove: false,
    canCorrect: false,
    isActionDisabled: false,
    engineerApprovalLimit: 50000,
    employeeIdLoginEnabled: false,
    hierarchyEnabled: false,
    teamLeaderTierEnabled: false,
    executiveTierEnabled: false,
    roleLabels: {},
    organizationId: "org-1",
    correctionDialogOpen: false,
    setCorrectionDialogOpen: noop,
    correctionLoading: false,
    corrTitle: "", setCorrTitle: noop,
    corrDestination: "", setCorrDestination: noop,
    corrExpenseDate: "", setCorrExpenseDate: noop,
    corrPurpose: "", setCorrPurpose: noop,
    corrCategory: "", setCorrCategory: noop,
    corrAmount: "", setCorrAmount: noop,
    corrAdminComment: "", setCorrAdminComment: noop,
    correctionReason: "", setCorrectionReason: noop,
    corrFieldModel: EMPTY_CORRECTION_FIELDS,
    onCorrFormFieldValuesChange: noop,
    onCorrBranchValuesChange: noop,
    onBack: noop,
    onVerify: noop,
    onApprove: noop,
    onReject: noop,
    onCorrect: noop,
    onSubmitCorrection: noop,
    onPreviewAttachment: noop,
  };

  it("renders employee name and expense title", () => {
    render(<MemoryRouter><MobileReviewDetailView {...detailProps} /></MemoryRouter>);
    expect(screen.getByText("Rahul Sharma")).toBeInTheDocument();
    expect(screen.getByText("Client Visit Mumbai")).toBeInTheDocument();
  });

  it("renders custom-fields display (prefetched, no extra fetch)", () => {
    render(<MemoryRouter><MobileReviewDetailView {...detailProps} /></MemoryRouter>);
    expect(screen.getByTestId("custom-fields")).toBeInTheDocument();
  });

  it("renders timeline", () => {
    render(<MemoryRouter><MobileReviewDetailView {...detailProps} /></MemoryRouter>);
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
  });

  it("renders attachment view buttons when attachments supplied", () => {
    const attachments = [{
      id: "att-1",
      filename: "receipt.jpg",
      content_type: "image/jpeg",
      file_url: "https://example.com/receipt.jpg",
      created_at: "2026-06-15T10:00:00Z",
    }];
    render(<MemoryRouter><MobileReviewDetailView {...detailProps} attachments={attachments} /></MemoryRouter>);
    expect(screen.getByText("receipt.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^view$/i })).toBeInTheDocument();
  });
});

// ── Test 10: Correction fields use existing labels ────────────────────────────

describe("10 — MobileCorrectionFields uses existing correction labels", () => {
  it("shows inline correction section when correctionDialogOpen=true", () => {
    const detailProps = {
      expense: baseExpense,
      attachments: [],
      lineItems: [],
      auditLogs: [],
      correctionLogs: [],
      timelineAssignees: {},
      engineerComment: "",
      setEngineerComment: noop,
      reviewLoading: false,
      canApprove: false,
      canCorrect: true,
      isActionDisabled: false,
      engineerApprovalLimit: 50000,
      employeeIdLoginEnabled: false,
      hierarchyEnabled: false,
      teamLeaderTierEnabled: false,
      executiveTierEnabled: false,
      roleLabels: {},
      organizationId: "org-1",
      correctionDialogOpen: true,
      setCorrectionDialogOpen: noop,
      correctionLoading: false,
      corrTitle: "Corrected title", setCorrTitle: noop,
      corrDestination: "Delhi", setCorrDestination: noop,
      corrExpenseDate: "2026-06-15", setCorrExpenseDate: noop,
      corrPurpose: "Trip purpose", setCorrPurpose: noop,
      corrCategory: "travel", setCorrCategory: noop,
      corrAmount: "12500", setCorrAmount: noop,
      corrAdminComment: "", setCorrAdminComment: noop,
      correctionReason: "Data entry error", setCorrectionReason: noop,
      corrFieldModel: EMPTY_CORRECTION_FIELDS,
      onCorrFormFieldValuesChange: noop,
      onCorrBranchValuesChange: noop,
      onBack: noop,
      onVerify: noop,
      onApprove: noop,
      onReject: noop,
      onCorrect: noop,
      onSubmitCorrection: noop,
      onPreviewAttachment: noop,
    };
    render(<MemoryRouter><MobileReviewDetailView {...detailProps} /></MemoryRouter>);
    // Correction section renders
    expect(screen.getByLabelText(/title/i)).toHaveValue("Corrected title");
    expect(screen.getByLabelText(/destination/i)).toHaveValue("Delhi");
    expect(screen.getByLabelText(/reason for correction/i)).toBeInTheDocument();
  });

  it("does NOT show inline correction when correctionDialogOpen=false", () => {
    const detailProps = {
      expense: baseExpense,
      attachments: [], lineItems: [], auditLogs: [], correctionLogs: [],
      timelineAssignees: {},
      engineerComment: "", setEngineerComment: noop,
      reviewLoading: false,
      canApprove: false, canCorrect: false, isActionDisabled: false,
      engineerApprovalLimit: 50000, employeeIdLoginEnabled: false,
      hierarchyEnabled: false, teamLeaderTierEnabled: false, executiveTierEnabled: false,
      roleLabels: {}, organizationId: "org-1",
      correctionDialogOpen: false, setCorrectionDialogOpen: noop,
      correctionLoading: false,
      corrTitle: "", setCorrTitle: noop, corrDestination: "", setCorrDestination: noop,
      corrExpenseDate: "", setCorrExpenseDate: noop, corrPurpose: "", setCorrPurpose: noop,
      corrCategory: "", setCorrCategory: noop, corrAmount: "", setCorrAmount: noop,
      corrAdminComment: "", setCorrAdminComment: noop, correctionReason: "", setCorrectionReason: noop,
      corrFieldModel: EMPTY_CORRECTION_FIELDS,
      onCorrFormFieldValuesChange: noop,
      onCorrBranchValuesChange: noop,
      onBack: noop, onVerify: noop, onApprove: noop, onReject: noop,
      onCorrect: noop, onSubmitCorrection: noop, onPreviewAttachment: noop,
    };
    render(<MemoryRouter><MobileReviewDetailView {...detailProps} /></MemoryRouter>);
    expect(screen.queryByLabelText(/reason for correction/i)).not.toBeInTheDocument();
  });
});

// ── Test 11: Action callbacks called exactly once ─────────────────────────────

describe("11 — MobileReviewActionBar callbacks called once", () => {
  it("onApprove called once when Approve tapped", () => {
    const onApprove = vi.fn();
    render(
      <MobileReviewActionBar
        expense={baseExpense}
        canApprove={true}
        canCorrect={false}
        isActionDisabled={false}
        reviewLoading={false}
        correctionOpen={false}
        onVerify={noop}
        onApprove={onApprove}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("onReject called once when Reject tapped", () => {
    const onReject = vi.fn();
    render(
      <MobileReviewActionBar
        expense={baseExpense}
        canApprove={false}
        canCorrect={false}
        isActionDisabled={false}
        reviewLoading={false}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={onReject}
        onCorrect={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("onCorrect called once when Correct tapped", () => {
    const onCorrect = vi.fn();
    render(
      <MobileReviewActionBar
        expense={baseExpense}
        canApprove={false}
        canCorrect={true}
        isActionDisabled={false}
        reviewLoading={false}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={onCorrect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /correct/i }));
    expect(onCorrect).toHaveBeenCalledTimes(1);
  });

  it("onVerify called once when Verify tapped (reviewer cannot approve)", () => {
    const onVerify = vi.fn();
    render(
      <MobileReviewActionBar
        expense={baseExpense}
        canApprove={false}
        canCorrect={false}
        isActionDisabled={false}
        reviewLoading={false}
        correctionOpen={false}
        onVerify={onVerify}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /verify/i }));
    expect(onVerify).toHaveBeenCalledTimes(1);
  });
});

// ── Test 12: Reject requires comment (engineerComment channel) ────────────────

describe("12 — Reject preserves existing comment / reason channel", () => {
  it("review comment textarea is present in detail view (channel for reject reason)", () => {
    render(
      <MemoryRouter>
        <MobileReviewDetailView
          expense={baseExpense}
          attachments={[]} lineItems={[]} auditLogs={[]} correctionLogs={[]}
          timelineAssignees={{}}
          engineerComment=""
          setEngineerComment={noop}
          reviewLoading={false}
          canApprove={false} canCorrect={false} isActionDisabled={false}
          engineerApprovalLimit={50000} employeeIdLoginEnabled={false}
          hierarchyEnabled={false} teamLeaderTierEnabled={false} executiveTierEnabled={false}
          roleLabels={{}} organizationId="org-1"
          correctionDialogOpen={false} setCorrectionDialogOpen={noop}
          correctionLoading={false}
          corrTitle="" setCorrTitle={noop} corrDestination="" setCorrDestination={noop}
          corrExpenseDate="" setCorrExpenseDate={noop} corrPurpose="" setCorrPurpose={noop}
          corrCategory="" setCorrCategory={noop} corrAmount="" setCorrAmount={noop}
          corrAdminComment="" setCorrAdminComment={noop} correctionReason="" setCorrectionReason={noop}
          corrFieldModel={EMPTY_CORRECTION_FIELDS}
          onCorrFormFieldValuesChange={noop}
          onCorrBranchValuesChange={noop}
          onBack={noop} onVerify={noop} onApprove={noop} onReject={noop}
          onCorrect={noop} onSubmitCorrection={noop} onPreviewAttachment={noop}
        />
      </MemoryRouter>,
    );
    expect(screen.getByPlaceholderText(/add your review comments/i)).toBeInTheDocument();
  });
});

// ── Test 13: Sticky action bar not fixed ─────────────────────────────────────

describe("13 — MobileReviewActionBar uses sticky positioning, not fixed", () => {
  it("action bar container has mobile-review-action-bar class (CSS sets position:sticky)", () => {
    const { container } = render(
      <MobileReviewActionBar
        expense={baseExpense}
        canApprove={false}
        canCorrect={false}
        isActionDisabled={false}
        reviewLoading={false}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    expect(container.querySelector(".mobile-review-action-bar")).toBeInTheDocument();
    // Confirm it does NOT use position:fixed inline style
    const bar = container.querySelector(".mobile-review-action-bar") as HTMLElement;
    expect(bar?.style.position).not.toBe("fixed");
  });
});

// ── Test 14: No duplicate fetch from mobile queue component ──────────────────

describe("14 — MobileReviewQueueView does not trigger its own data fetch", () => {
  it("renders supplied expenses without calling supabase.from directly", () => {
    vi.mocked(supabase.from).mockClear();
    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[baseExpense]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(vi.mocked(supabase.from)).not.toHaveBeenCalled();
  });
});

// ── Test 15: Desktop EngineerReview unchanged at 768px+ ──────────────────────

describe("15 — Mobile queue is purely presentational (no table markup = desktop-only)", () => {
  it("MobileReviewQueueView renders card list, no <table> (desktop uses table; mobile uses cards)", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[baseExpense]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    // Mobile queue uses card divs, not a <table>; desktop EngineerReview uses <table>
    expect(container.querySelector("table")).not.toBeInTheDocument();
    expect(container.querySelector(".mobile-review-card")).toBeInTheDocument();
  });
});

// ── Test 16: MobileReviewExpenseCard bulk checkbox rendering ─────────────────

describe("16 — MobileReviewExpenseCard bulk checkbox rendering", () => {
  it("renders a checkbox when isSelectable=true", () => {
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={true}
        isSelectable={true}
        isSelected={false}
        onToggleSelect={noop}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("does NOT render a checkbox when isSelectable=false", () => {
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        isSelectable={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("does NOT render a checkbox when isSelectable is omitted", () => {
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("renders checkbox checked when isSelected=true", () => {
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={true}
        isSelectable={true}
        isSelected={true}
        onToggleSelect={noop}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  });

  it("renders checkbox unchecked when isSelected=false", () => {
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={true}
        isSelectable={true}
        isSelected={false}
        onToggleSelect={noop}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "false");
  });

  it("renders checkbox as disabled when selectionDisabled=true", () => {
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={true}
        isSelectable={true}
        isSelected={false}
        onToggleSelect={noop}
        selectionDisabled={true}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
});

// ── Test 17: MobileReviewExpenseCard bulk checkbox interaction ───────────────

describe("17 — MobileReviewExpenseCard bulk checkbox stopPropagation", () => {
  it("tapping the card body calls onSelect, not onToggleSelect", () => {
    const onSelect = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={true}
        isSelectable={true}
        isSelected={false}
        onToggleSelect={onToggleSelect}
        formatSubline={formatSubline}
        onSelect={onSelect}
      />,
    );
    // Click the title text (card body, not the checkbox container)
    fireEvent.click(screen.getByText("Client Visit Mumbai"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
  });
});

// ── Test 18: MobileReviewQueueView bulk prop threading ───────────────────────

describe("18 — MobileReviewQueueView bulk selection prop threading", () => {
  it("batch expense does not get a checkbox even when it is pending", () => {
    const batchExpense: Expense = {
      ...baseExpense,
      id: "batch-exp-1",
      batch_id: "batch-001",
    };
    const isSelectableForBulk = (exp: Expense) =>
      !exp.batch_id && exp.status !== "approved" && exp.status !== "rejected";

    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[batchExpense]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => true}
          isSelectableForBulk={isSelectableForBulk}
          selectedKeys={new Set()}
          onToggleSelect={noop}
          bulkActionLoading={false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    // Batch expense should have no checkbox
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("non-batch pending expense gets a checkbox", () => {
    const isSelectableForBulk = (exp: Expense) =>
      !exp.batch_id && exp.status !== "approved" && exp.status !== "rejected";

    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[baseExpense]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => true}
          isSelectableForBulk={isSelectableForBulk}
          selectedKeys={new Set()}
          onToggleSelect={noop}
          bulkActionLoading={false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("expense in selectedExpenseIds renders its checkbox as checked", () => {
    const isSelectableForBulk = () => true;

    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[baseExpense]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="all"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => true}
          isSelectableForBulk={isSelectableForBulk}
          selectedKeys={new Set(["expense:exp-1"])}
          onToggleSelect={noop}
          bulkActionLoading={false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
  });

  it("approved expense does not get a checkbox", () => {
    const approvedExpense: Expense = { ...baseExpense, status: "approved" };
    const isSelectableForBulk = (exp: Expense) =>
      exp.status !== "approved" && exp.status !== "rejected";

    render(
      <MemoryRouter>
        <MobileReviewQueueView
          expenses={[approvedExpense]}
          loading={false}
          searchTerm=""
          setSearchTerm={noop}
          statusFilter="approved"
          setStatusFilter={noop}
          timePeriod="all"
          setTimePeriod={noop}
          managerFetchWarning={null}
          isPendingForCurrentReviewer={() => false}
          isSelectableForBulk={isSelectableForBulk}
          selectedKeys={new Set()}
          onToggleSelect={noop}
          bulkActionLoading={false}
          formatSubline={formatSubline}
          onSelectExpense={noopAsync}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});
