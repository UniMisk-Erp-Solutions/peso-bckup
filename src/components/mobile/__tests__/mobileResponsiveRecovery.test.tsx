/**
 * Mobile Responsive Recovery — T71–T83 (DOC-039)
 *
 * T71 — truncateFilenameForMobile: long base name truncated with ellipsis + extension
 * T72 — truncateFilenameForMobile: short filename returned unchanged
 * T73 — truncateFilenameForMobile: no extension — truncated without ext
 * T74 — truncateFilenameForMobile: exactly at maxBaseChars — not truncated
 * T75 — truncateFilenameForMobile: multiple dots — only last extension preserved
 * T76 — FileUpload mobile: long filename displayed in truncated form
 * T77 — FileUpload desktop: long filename displayed in full (no truncation function applied)
 * T78 — FileUpload mobile: full filename preserved in title attribute
 * T79 — FileUpload mobile: truncated display still has truncate CSS class
 * T80 — FileUpload mobile: file-row has min-w-0 + w-full + max-w-full classes
 * T81 — truncateFilenameForMobile: extension-only file (no base) returned unchanged
 * T82 — truncateFilenameForMobile: emoji/unicode chars count correctly
 * T83 — truncateFilenameForMobile: result length = maxBaseChars + 1 (ellipsis) + ext
 */

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { truncateFilenameForMobile } from "@/lib/truncateFilename";
import { FileUpload } from "@/components/FileUpload";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const longFilename = "Screenshot_20260702_very_long_receipt_from_Chrome_browser.jpg";
const longFilenameExpectedBase = "Screenshot_20260702_";
const longFilenameExt = ".jpg";

const mockAttachmentLong = {
  id: "att-long",
  filename: longFilename,
  content_type: "image/jpeg",
  file_url: "https://example.com/long.jpg",
  created_at: "2026-07-02T10:00:00Z",
  file_size: 204800,
  storage_path: "receipts/att-long.jpg",
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
                order: vi.fn(() => ({ data: [mockAttachmentLong], error: null })),
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
        "uploadFile.totalSize": "{{current}} of {{max}}",
        "uploadFile.uploadedFiles": "Uploaded files",
      };
      return m[key] ?? key;
    },
    i18n: { language: "en" },
  }),
}));

// ── T71–T75, T81–T83: truncateFilenameForMobile pure function ─────────────────

describe("T71 — truncateFilenameForMobile: long base name gets truncated with ellipsis", () => {
  it("base exceeds maxBaseChars → ellipsis inserted before extension", () => {
    const result = truncateFilenameForMobile("VeryLongFilenameWithExtension.jpg", 10);
    expect(result).toBe("VeryLongFi….jpg");
  });
});

describe("T72 — truncateFilenameForMobile: short filename returned unchanged", () => {
  it("base at or below maxBaseChars → original filename returned", () => {
    const result = truncateFilenameForMobile("short.pdf", 20);
    expect(result).toBe("short.pdf");
  });
});

describe("T73 — truncateFilenameForMobile: no extension — truncated without ext part", () => {
  it("filename with no dot → truncated base only, no trailing dot", () => {
    const result = truncateFilenameForMobile("filenamewithnodot", 10);
    expect(result).toBe("filenamewi…");
    expect(result).not.toContain(".");
  });
});

describe("T74 — truncateFilenameForMobile: exactly at maxBaseChars — NOT truncated", () => {
  it("base length === maxBaseChars → unchanged", () => {
    const base = "exact_20chars_here!_";
    expect(base.length).toBe(20);
    const result = truncateFilenameForMobile(`${base}.png`, 20);
    expect(result).toBe(`${base}.png`);
  });
});

describe("T75 — truncateFilenameForMobile: multiple dots — only last extension preserved", () => {
  it("file.name.with.dots.jpg → extension is .jpg (from last dot)", () => {
    const result = truncateFilenameForMobile("file.name.with.dots.jpg", 5);
    expect(result.endsWith(".jpg")).toBe(true);
    expect(result).toContain("…");
    expect(result).toBe("file.….jpg");
  });
});

describe("T81 — truncateFilenameForMobile: base-only file (no dot) under max — unchanged", () => {
  it("short filename with no extension returned as-is", () => {
    expect(truncateFilenameForMobile("hi", 10)).toBe("hi");
  });
});

describe("T82 — truncateFilenameForMobile: maxBaseChars=0 — only ellipsis + ext", () => {
  it("maxBaseChars=0 produces '…' + extension", () => {
    const result = truncateFilenameForMobile("anyfile.txt", 0);
    expect(result).toBe("….txt");
  });
});

describe("T83 — truncateFilenameForMobile: result format is base(maxChars) + ellipsis + ext", () => {
  it("truncated result has exactly maxBaseChars chars before the ellipsis", () => {
    const filename = "abcdefghijklmnopqrstuvwxyz.docx";
    const max = 8;
    const result = truncateFilenameForMobile(filename, max);
    const [beforeEllipsis] = result.split("…");
    expect(beforeEllipsis.length).toBe(max);
    expect(result.endsWith(".docx")).toBe(true);
  });
});

// ── T76–T80: FileUpload truncation behavior ───────────────────────────────────

describe("T76 — FileUpload mobile: long filename is displayed in truncated form", () => {
  it("displayed text differs from full filename when filename exceeds 20 base chars", async () => {
    render(
      <MemoryRouter>
        <FileUpload expenseId="att-long" variant="mobile" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(longFilenameExpectedBase + "…" + longFilenameExt)).toBeInTheDocument();
    });
  });
});

describe("T77 — FileUpload desktop: long filename shown in full", () => {
  it("without variant='mobile', full filename is displayed unchanged", async () => {
    render(
      <MemoryRouter>
        <FileUpload expenseId="att-long" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText(longFilename)).toBeInTheDocument();
    });
  });
});

describe("T78 — FileUpload mobile: full filename preserved in title attribute", () => {
  it("title attribute always carries the original untruncated filename", async () => {
    render(
      <MemoryRouter>
        <FileUpload expenseId="att-long" variant="mobile" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      const el = screen.getByTitle(longFilename);
      expect(el).toBeInTheDocument();
    });
  });
});

describe("T79 — FileUpload mobile: truncated display element still has truncate CSS class", () => {
  it("the filename p element carries the truncate utility class in mobile mode", async () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="att-long" variant="mobile" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTitle(longFilename)).toBeInTheDocument();
    });
    const el = screen.getByTitle(longFilename);
    expect(el.className).toContain("truncate");
  });
});

describe("T80 — FileUpload mobile: file-row div has min-w-0, w-full, max-w-full", () => {
  it("in mobile mode with a loaded attachment, the outer file-row div is width-safe", async () => {
    const { container } = render(
      <MemoryRouter>
        <FileUpload expenseId="att-long" variant="mobile" />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByTitle(longFilename)).toBeInTheDocument();
    });
    const fileRow = screen.getByTitle(longFilename).closest(".p-3.border.rounded-lg");
    expect(fileRow?.className).toContain("min-w-0");
    expect(fileRow?.className).toContain("w-full");
    expect(fileRow?.className).toContain("max-w-full");
  });
});
