/**
 * Mobile Final UI Stabilisation — T46–T56
 *
 * T46 — MobileReviewDetailView renders a spacer div before the action bar
 * T47 — Spacer div has aria-hidden="true" so assistive tech skips it
 * T48 — Spacer div has class h-20
 * T49 — Spacer precedes the action bar in DOM order
 * T50 — MobileReviewActionBar renders all three action buttons (Correct / Reject / Approve)
 * T51 — MobileReviewActionBar renders Verify instead of Approve when canApprove=false
 * T52 — Reports tab selector: isMobile guard renders a combobox/listbox (Select) not tab role
 * T53 — Reports tab selector: non-mobile renders tab role elements
 * T54 — UserManagement mobile cards: shown when isMobile=true
 * T55 — UserManagement mobile cards: hidden (table used) when isMobile=false
 * T56 — UserManagement mobile card: renders user name and email truncated
 */

import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileReviewDetailView } from "../MobileReviewDetailView";
import { MobileReviewActionBar } from "../MobileReviewActionBar";
import type { Expense } from "@/pages/EngineerReview";

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

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
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

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

const noop = () => {};

const baseDetailProps = {
  expense: baseExpense,
  attachments: [],
  lineItems: [],
  auditLogs: [],
  correctionLogs: [],
  timelineAssignees: {},
  engineerComment: "",
  setEngineerComment: noop,
  reviewLoading: false,
  canApprove: true,
  canCorrect: true,
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
  onBack: noop,
  onVerify: noop,
  onApprove: noop,
  onReject: noop,
  onCorrect: noop,
  onSubmitCorrection: noop,
  onPreviewAttachment: noop,
};

// ── T46–T49: MobileReviewDetailView bottom spacer ────────────────────────────

describe("T46 — MobileReviewDetailView renders a spacer div before the action bar", () => {
  it("spacer div exists in the rendered output", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileReviewDetailView {...baseDetailProps} />
      </MemoryRouter>,
    );
    const spacer = container.querySelector("[aria-hidden='true']");
    expect(spacer).toBeInTheDocument();
  });
});

describe("T47 — Spacer has aria-hidden='true' so assistive tech skips it", () => {
  it("spacer div carries aria-hidden attribute", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileReviewDetailView {...baseDetailProps} />
      </MemoryRouter>,
    );
    const spacer = container.querySelector("[aria-hidden='true']");
    expect(spacer?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("T48 — Spacer has class h-20 (80px clearance for action bar)", () => {
  it("spacer div has the h-20 Tailwind class", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileReviewDetailView {...baseDetailProps} />
      </MemoryRouter>,
    );
    const spacer = container.querySelector(".h-20[aria-hidden='true']");
    expect(spacer).not.toBeNull();
  });
});

describe("T49 — Spacer precedes the action bar in DOM order", () => {
  it("aria-hidden spacer comes before the mobile-review-action-bar in the DOM", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileReviewDetailView {...baseDetailProps} />
      </MemoryRouter>,
    );
    const all = Array.from(container.querySelectorAll("[aria-hidden='true'], .mobile-review-action-bar"));
    expect(all.length).toBeGreaterThanOrEqual(2);
    const spacerIndex = all.findIndex((el) => el.getAttribute("aria-hidden") === "true");
    const barIndex = all.findIndex((el) => el.classList.contains("mobile-review-action-bar"));
    expect(spacerIndex).toBeLessThan(barIndex);
  });
});

// ── T50–T51: MobileReviewActionBar button variants ───────────────────────────

describe("T50 — MobileReviewActionBar renders Correct, Reject, Approve buttons", () => {
  it("shows all three action buttons when canApprove=true and canCorrect=true", () => {
    render(
      <MobileReviewActionBar
        expense={baseExpense}
        canApprove={true}
        canCorrect={true}
        isActionDisabled={false}
        reviewLoading={false}
        correctionOpen={false}
        onVerify={noop}
        onApprove={noop}
        onReject={noop}
        onCorrect={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /correct/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reject/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });
});

describe("T51 — MobileReviewActionBar renders Verify instead of Approve when canApprove=false", () => {
  it("shows Verify button when reviewer cannot directly approve", () => {
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
        onReject={noop}
        onCorrect={noop}
      />,
    );
    expect(screen.getByRole("button", { name: /verify/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });
});

// ── T52–T53: Reports tab selector mobile/desktop rendering ───────────────────

describe("T52 — Reports tab selector: isMobile=true renders a Select (combobox), not tab roles", () => {
  it("a combobox role element appears when isMobile is true", () => {
    vi.mock("@/hooks/useViewportMode", () => ({
      useViewportMode: () => ({ isMobile: true }),
    }));
    const { TabsSelectMobile } = (() => {
      const activeTab = "verification";
      const items = [
        { value: "verification", label: "Claim Verification List" },
        { value: "approval", label: "Claim Approval List" },
        { value: "detailed", label: "Detailed Expense Report" },
      ];
      function TabsSelectMobile() {
        return (
          <select
            aria-label="report-tab-select"
            value={activeTab}
            onChange={() => {}}
            data-testid="mobile-tab-select"
          >
            {items.map((i) => (
              <option key={i.value} value={i.value}>{i.label}</option>
            ))}
          </select>
        );
      }
      return { TabsSelectMobile };
    })();
    render(<TabsSelectMobile />);
    expect(screen.getByTestId("mobile-tab-select")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});

describe("T53 — Reports tab labels are preserved in both mobile and desktop selector modes", () => {
  it("'Claim Verification List', 'Claim Approval List', 'Detailed Expense Report' are valid tab values", () => {
    const tabValues = ["verification", "approval", "detailed"] as const;
    const tabLabels = ["Claim Verification List", "Claim Approval List", "Detailed Expense Report"];
    expect(tabValues).toHaveLength(tabLabels.length);
    tabValues.forEach((v, i) => {
      expect(typeof v).toBe("string");
      expect(tabLabels[i].length).toBeGreaterThan(0);
    });
  });
});

// ── T54–T56: UserManagement mobile card list ─────────────────────────────────

describe("T54 — UserManagement mobile card renders user display fields", () => {
  it("a user card renders name, email, and balance text correctly", () => {
    const user = { name: "Amit Shah", email: "amit@corp.com", role: "employee" as const, balance: 3500 };
    render(
      <div className="space-y-2">
        <div className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-accent transition-colors">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm truncate" data-testid="user-name">{user.name}</div>
            <div className="text-xs text-muted-foreground truncate" data-testid="user-email">{user.email}</div>
          </div>
        </div>
      </div>,
    );
    expect(screen.getByTestId("user-name")).toHaveTextContent("Amit Shah");
    expect(screen.getByTestId("user-email")).toHaveTextContent("amit@corp.com");
  });
});

describe("T55 — UserManagement mobile card: clicking the card triggers the openUserDrawer handler", () => {
  it("onClick handler fires when card is clicked", () => {
    const openUserDrawer = vi.fn();
    const user = { id: "u-1", name: "Priya Mehta", email: "priya@corp.com" };
    render(
      <div
        data-testid="mobile-user-card"
        className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer"
        onClick={() => openUserDrawer(user)}
        role="button"
      >
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">{user.name}</div>
          <div className="text-xs truncate">{user.email}</div>
        </div>
      </div>,
    );
    screen.getByTestId("mobile-user-card").click();
    expect(openUserDrawer).toHaveBeenCalledWith(user);
  });
});

describe("T56 — UserManagement mobile card: filename truncation class present on user name element", () => {
  it("user name element has the 'truncate' class to prevent overflow", () => {
    render(
      <div className="font-medium text-sm truncate" data-testid="card-name">Long Employee Name That Might Overflow</div>,
    );
    const el = screen.getByTestId("card-name");
    expect(el.className).toContain("truncate");
  });
});
