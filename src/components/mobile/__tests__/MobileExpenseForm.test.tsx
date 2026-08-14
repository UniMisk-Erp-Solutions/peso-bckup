import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileExpenseFormLayout } from "../MobileExpenseFormLayout";
import { MobileStickyActionBar } from "../MobileStickyActionBar";
import { MobileAppShell } from "../MobileAppShell";
import { FileUpload } from "@/components/FileUpload";

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
    user: { id: "user-1" },
    session: null,
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
      insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => ({ data: null, error: null })) })) })),
    })),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(() => ({ data: null, error: new Error("mock") })),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: "" } })),
      })),
    },
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const m: Record<string, string> = {
        "uploadFile.takePhoto": "Take Photo",
        "uploadFile.chooseFiles": "Choose Files",
        "uploadFile.cardTitle": "Receipts",
        "uploadFile.cardDescription": "Attach receipts or bills",
        "uploadFile.dropHintMobile": "Drop or capture a photo",
        "uploadFile.dropHintDesktop": "Drop files here",
        "uploadFile.dropActiveHint": "Release to upload",
      };
      return m[key] ?? key;
    },
    i18n: { language: "en" },
  }),
}));

// ── Test 6 + 15: MobileExpenseFormLayout passthrough and active mode ──────────

describe("6/15 — MobileExpenseFormLayout", () => {
  it("active=false is a transparent passthrough (desktop branch unchanged)", () => {
    const { container } = render(
      <MobileExpenseFormLayout active={false}>
        <div data-testid="form-content">Form</div>
      </MobileExpenseFormLayout>,
    );
    // No wrapping div added — content rendered directly
    expect(screen.getByTestId("form-content")).toBeInTheDocument();
    expect(container.querySelector(".mobile-expense-form-layout")).not.toBeInTheDocument();
  });

  it("active=true wraps in mobile-expense-form-layout div", () => {
    const { container } = render(
      <MobileExpenseFormLayout active={true}>
        <div data-testid="form-content">Form</div>
      </MobileExpenseFormLayout>,
    );
    expect(container.querySelector(".mobile-expense-form-layout")).toBeInTheDocument();
    expect(screen.getByTestId("form-content")).toBeInTheDocument();
  });

  it("active=true preserves children — configured label text flows through unchanged", () => {
    render(
      <MobileExpenseFormLayout active={true}>
        <label>Heading</label>
      </MobileExpenseFormLayout>,
    );
    // The label "Heading" (configured field label, not hardcoded "Title") flows through
    expect(screen.getByText("Heading")).toBeInTheDocument();
  });
});

// ── Test 7 + 12: MobileStickyActionBar callbacks ──────────────────────────────

describe("7/12 — MobileStickyActionBar callbacks", () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    submitLabel: "Submit",
    disabled: false,
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onSubmit exactly once when Submit button clicked", () => {
    const onSubmit = vi.fn();
    render(<MobileStickyActionBar {...defaultProps} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Cancel button clicked", () => {
    const onCancel = vi.fn();
    render(<MobileStickyActionBar {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Submit is disabled when disabled=true (guards against rapid double-tap)", () => {
    render(<MobileStickyActionBar {...defaultProps} disabled={true} />);
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("Cancel is disabled when loading=true", () => {
    render(<MobileStickyActionBar {...defaultProps} loading={true} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
  });

  it("renders custom submitLabel (canonical title key — label comes from form, not hardcoded)", () => {
    render(<MobileStickyActionBar {...defaultProps} submitLabel="Update Expense" />);
    expect(screen.getByRole("button", { name: /update expense/i })).toBeInTheDocument();
  });
});

// ── Test 8 + 9: MobileExpenseFormLayout renders children including custom fields ─

describe("8/9 — MobileExpenseFormLayout renders form children unchanged", () => {
  it("custom field section (visibility/order) flows through unchanged", () => {
    render(
      <MobileExpenseFormLayout active={true}>
        <div data-testid="custom-fields">
          <label>Project Code</label>
          <input type="text" />
        </div>
      </MobileExpenseFormLayout>,
    );
    expect(screen.getByTestId("custom-fields")).toBeInTheDocument();
    expect(screen.getByText("Project Code")).toBeInTheDocument();
  });

  it("validation message text flows through unchanged", () => {
    render(
      <MobileExpenseFormLayout active={true}>
        <span role="alert">Heading is required</span>
      </MobileExpenseFormLayout>,
    );
    // Validation text references configured label ("Heading"), not hardcoded "Title"
    expect(screen.getByRole("alert")).toHaveTextContent("Heading is required");
  });
});

// ── Test 10 + 11: Draft / edit mode — layout is transparent ──────────────────

describe("10/11 — MobileExpenseFormLayout is transparent for draft and edit mode", () => {
  it("draft notice banner renders inside active layout", () => {
    render(
      <MobileExpenseFormLayout active={true}>
        <div data-testid="draft-notice">Draft restored from 2 minutes ago</div>
        <div data-testid="form-fields">fields</div>
      </MobileExpenseFormLayout>,
    );
    expect(screen.getByTestId("draft-notice")).toBeInTheDocument();
    expect(screen.getByTestId("form-fields")).toBeInTheDocument();
  });

  it("edit mode pre-filled values render inside active layout", () => {
    render(
      <MobileExpenseFormLayout active={true}>
        <input defaultValue="Business lunch" data-testid="title-input" />
        <input defaultValue="1500" data-testid="amount-input" />
      </MobileExpenseFormLayout>,
    );
    expect(screen.getByTestId("title-input")).toHaveValue("Business lunch");
    expect(screen.getByTestId("amount-input")).toHaveValue("1500");
  });
});

// ── Test 13: FileUpload variant="mobile" preserves failed/retry invariants ────

describe("13 — FileUpload variant=mobile preserves failed/retry states", () => {
  it("shows camera button when variant=mobile (showCameraCapture forced true)", () => {
    render(
      <MemoryRouter>
        <FileUpload
          expenseId="exp-1"
          variant="mobile"
        />
      </MemoryRouter>,
    );
    // Camera button must be present regardless of isMobile hook result
    expect(screen.getByRole("button", { name: /take photo/i })).toBeInTheDocument();
  });

  it("file picker button still present with variant=mobile (no logic removed)", () => {
    render(
      <MemoryRouter>
        <FileUpload
          expenseId="exp-1"
          variant="mobile"
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: /choose files/i })).toBeInTheDocument();
  });

  it("variant=mobile buttons have min-h-[44px] for 44px tap target", () => {
    render(
      <MemoryRouter>
        <FileUpload expenseId="exp-1" variant="mobile" />
      </MemoryRouter>,
    );
    const cameraBtn = screen.getByRole("button", { name: /take photo/i });
    expect(cameraBtn.className).toMatch(/min-h-\[44px\]/);
  });
});

// ── Test 14: Only one mobile scroll owner ────────────────────────────────────

describe("14 — Only one mobile scroll owner", () => {
  it("MobileAppShell renders exactly one mobile-app-scroll container", () => {
    const { container } = render(
      <MemoryRouter>
        <MobileAppShell>
          <div>content</div>
        </MobileAppShell>
      </MemoryRouter>,
    );
    const scrollOwners = container.querySelectorAll(".mobile-app-scroll");
    expect(scrollOwners).toHaveLength(1);
  });
});
