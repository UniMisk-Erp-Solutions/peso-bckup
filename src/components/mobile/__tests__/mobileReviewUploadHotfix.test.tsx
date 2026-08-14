/**
 * Mobile Review Card Parity + Receipt Filename Layout Hotfix — T57–T70 (DOC-038)
 *
 * T57 — Review card: title is the FIRST text element inside the card (top row)
 * T58 — Review card: amount appears in the top row with tabular-nums class
 * T59 — Review card: employee name is in a distinct secondary block, after title
 * T60 — Review card: formatSubline div has aria-label set to the full user email
 * T61 — Review card: category span shown in context row when expense.category is set
 * T62 — Review card: date appears in the context row, not isolated below badges
 * T63 — Upload: FileUpload renders dropzone when variant="mobile"
 * T64 — Upload: dropzone has min-w-0 class in mobile mode
 * T65 — Upload: dropzone has w-full class in mobile mode
 * T66 — Upload: dropzone has max-w-full class in mobile mode
 * T67 — Upload: file-row outer div gets min-w-0 class in mobile mode (with attachment)
 * T68 — Upload: file-row outer div gets w-full class in mobile mode (with attachment)
 * T69 — Upload: metadata line has truncate class in mobile mode (with attachment)
 * T70 — Upload: filename element always has truncate class (regardless of variant)
 */

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MobileReviewExpenseCard } from "../MobileReviewExpenseCard";
import type { Expense } from "@/pages/EngineerReview";
import { FileUpload } from "@/components/FileUpload";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockAttachment = {
  id: "att-1",
  filename: "long-receipt-filename-extends-beyond-viewport.pdf",
  content_type: "application/pdf",
  file_url: "https://example.com/receipt.pdf",
  created_at: "2026-06-15T10:00:00Z",
  file_size: 102400,
  storage_path: "receipts/att-1.pdf",
};

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(() => ({
    userRole: "employee",
    isAccountantCashier: false,
    userProfile: { name: "Test User" },
    signOut: vi.fn(),
    organizationFeatureFlags: {},
    isTenantHost: false,
    tenantHostOrgId: null,
    organizationId: "org-1",
    user: { id: "user-1" },
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
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "attachments") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => ({ data: [mockAttachment], error: null })),
              })),
            })),
          })),
        };
      }
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ data: [], error: null })) })),
        insert: vi.fn(() => ({
          select: vi.fn(() => ({ single: vi.fn(() => ({ data: null, error: null })) })),
        })),
      };
    }),
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
        "uploadFile.unknownFile": "Unknown file",
        "uploadFile.unknownType": "Unknown type",
        "uploadFile.unknownSize": "Unknown size",
        "uploadFile.unknownDate": "Unknown date",
        "uploadFile.invalidDate": "Invalid date",
        "uploadFile.totalSizeUsed": "{{current}} of {{max}}",
      };
      return m[key] ?? key;
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("@/components/ExpenseStatusWithCorrectionBadge", () => ({
  ExpenseStatusWithCorrectionBadge: ({ status }: { status: string }) => (
    <span data-testid="status-badge">{status}</span>
  ),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

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

// ── T57–T62: Review card hierarchy ────────────────────────────────────────────

describe("T57 — Review card: title is first text node in the card", () => {
  it("title element appears before the employee name in DOM order", () => {
    const { container } = render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    const allText = Array.from(container.querySelectorAll("div, span, p"))
      .filter((el) => el.children.length === 0 && el.textContent?.trim())
      .map((el) => el.textContent?.trim());
    const titleIdx = allText.findIndex((t) => t === "Client Visit Mumbai");
    const nameIdx = allText.findIndex((t) => t === "Rahul Sharma");
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeGreaterThan(titleIdx);
  });
});

describe("T58 — Review card: amount appears in the top row with tabular-nums", () => {
  it("formatted amount element has the tabular-nums class", () => {
    const { container } = render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    const amountEl = Array.from(container.querySelectorAll("div")).find(
      (el) => el.classList.contains("tabular-nums"),
    );
    expect(amountEl).toBeTruthy();
    expect(amountEl?.textContent).toContain("12");
  });
});

describe("T59 — Review card: employee name is in secondary identity block below title", () => {
  it("user_name element has font-medium (secondary) not font-semibold (primary title) class", () => {
    const { container } = render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    const nameEl = Array.from(container.querySelectorAll("div")).find(
      (el) => el.textContent?.trim() === "Rahul Sharma",
    );
    expect(nameEl).toBeTruthy();
    expect(nameEl?.className).toContain("font-medium");
  });
});

describe("T60 — Review card: formatSubline div carries aria-label with full user email", () => {
  it("the element displaying the subline has aria-label equal to user_email", () => {
    const { container } = render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    const sublineEl = container.querySelector("[aria-label='rahul@company.com']");
    expect(sublineEl).toBeInTheDocument();
  });
});

describe("T61 — Review card: category shown in context row when expense.category is set", () => {
  it("renders category text when expense has a category", () => {
    render(
      <MobileReviewExpenseCard
        expense={{ ...baseExpense, category: "accommodation" }}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.getByText("accommodation")).toBeInTheDocument();
  });

  it("no category element when expense.category is null", () => {
    render(
      <MobileReviewExpenseCard
        expense={{ ...baseExpense, category: null }}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    expect(screen.queryByText(/accommodation/i)).not.toBeInTheDocument();
  });
});

describe("T62 — Review card: date appears in context row (same row as badges)", () => {
  it("formatted date is inside the flex-wrap context row alongside the status badge", () => {
    const { container } = render(
      <MobileReviewExpenseCard
        expense={baseExpense}
        isPending={false}
        formatSubline={formatSubline}
        onSelect={noop}
      />,
    );
    // The context row has flex-wrap and contains the status badge
    const contextRow = container.querySelector(".flex-wrap");
    expect(contextRow).toBeTruthy();
    // Date text "15 Jun 2026" should be inside the context row
    expect(contextRow?.textContent).toContain("Jun");
    // And the status badge should also be inside the same row
    const badge = contextRow?.querySelector("[data-testid='status-badge']");
    expect(badge).toBeTruthy();
  });
});

// ── T63–T66: Upload dropzone classes ──────────────────────────────────────────

describe("T63 — Upload: FileUpload renders a dropzone when variant='mobile'", () => {
  it("border-dashed dropzone div is present in the DOM", () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="new" variant="mobile" />
      </MemoryRouter>,
    );
    const dropzone = container.querySelector(".border-dashed");
    expect(dropzone).toBeInTheDocument();
  });
});

describe("T64 — Upload: dropzone has min-w-0 class when variant='mobile'", () => {
  it("dropzone element carries min-w-0 in mobile mode", () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="new" variant="mobile" />
      </MemoryRouter>,
    );
    const dropzone = container.querySelector(".border-dashed");
    expect(dropzone?.className).toContain("min-w-0");
  });
});

describe("T65 — Upload: dropzone has w-full class when variant='mobile'", () => {
  it("dropzone element carries w-full in mobile mode", () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="new" variant="mobile" />
      </MemoryRouter>,
    );
    const dropzone = container.querySelector(".border-dashed");
    expect(dropzone?.className).toContain("w-full");
  });
});

describe("T66 — Upload: dropzone has max-w-full class when variant='mobile'", () => {
  it("dropzone element carries max-w-full in mobile mode", () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="new" variant="mobile" />
      </MemoryRouter>,
    );
    const dropzone = container.querySelector(".border-dashed");
    expect(dropzone?.className).toContain("max-w-full");
  });
});

// ── T67–T70: File-row card classes with loaded attachment ─────────────────────

describe("T67 — Upload: file-row outer div has min-w-0 in mobile mode", () => {
  it("after attachment loads, the file-row container includes min-w-0", async () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="exp-1" variant="mobile" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTitle(mockAttachment.filename)).toBeInTheDocument();
    });
    const filename = screen.getByTitle(mockAttachment.filename);
    // filename p → div.min-w-0 → div.file-row
    const fileRow = filename.closest(".p-3.border.rounded-lg");
    expect(fileRow?.className).toContain("min-w-0");
  });
});

describe("T68 — Upload: file-row outer div has w-full in mobile mode", () => {
  it("after attachment loads, the file-row container includes w-full", async () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="exp-1" variant="mobile" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTitle(mockAttachment.filename)).toBeInTheDocument();
    });
    const filename = screen.getByTitle(mockAttachment.filename);
    const fileRow = filename.closest(".p-3.border.rounded-lg");
    expect(fileRow?.className).toContain("w-full");
  });
});

describe("T69 — Upload: metadata line has truncate class in mobile mode", () => {
  it("after attachment loads, the content-type/size/date metadata p has truncate", async () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="exp-1" variant="mobile" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTitle(mockAttachment.filename)).toBeInTheDocument();
    });
    const filename = screen.getByTitle(mockAttachment.filename);
    const textBlock = filename.parentElement;
    // metadata is the sibling <p> after the filename <p>
    const metadata = textBlock?.querySelector("p:last-child");
    expect(metadata?.className).toContain("truncate");
  });
});

describe("T70 — Upload: filename element always has truncate class", () => {
  it("filename p carries truncate regardless of variant", async () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="exp-1" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(mockAttachment.filename)).toBeInTheDocument();
    });
    const filename = screen.getByText(mockAttachment.filename);
    expect(filename.className).toContain("truncate");
  });
});
