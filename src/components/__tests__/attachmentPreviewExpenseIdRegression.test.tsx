/**
 * Regression: "expenseId is not defined" (GlitchTip PESOWISE-WEB-KF).
 *
 * `AttachmentPreviewDialog` declared `expenseId` in its props type and read it
 * when resolving a preview, but never destructured it. At runtime that made
 * `expenseId` a FREE identifier — the minifier left the name un-renamed while
 * every sibling local became a one-letter name, which is its signature for a
 * global reference:
 *
 *   {fallbackTempUserId: l, fallbackExpenseId: expenseId}
 *
 * Opening a receipt preview on /expenses/new therefore threw
 * `ReferenceError: expenseId is not defined` into the ErrorBoundary.
 *
 * TypeScript did not catch it, so a type-level guard is not sufficient here.
 * These tests RENDER the component and exercise the preview path, so the free
 * identifier would throw for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const resolveImage = vi.fn();
const resolvePdf = vi.fn();

vi.mock("@/lib/attachmentPreview", () => ({
  // The dialog resolves images through resolveImagePreviewSource (it needs to tell a
  // missing file apart from an undecodable one). Delegating to the same spy keeps the
  // argument-forwarding assertions below pointed at the call the component actually makes.
  resolveImagePreviewSource: async (...a: unknown[]) => {
    const objectUrl = (await resolveImage(...a)) ?? null;
    return {
      status: objectUrl ? "ok" : "missing",
      objectUrl,
      originalObjectUrl: objectUrl,
    };
  },
  resolveImagePreviewObjectUrl: (...a: unknown[]) => resolveImage(...a),
  resolvePdfPreviewObjectUrl: (...a: unknown[]) => resolvePdf(...a),
  // Real implementation, kept simple: the component only needs the branch.
  isPdfAttachment: (contentType?: string | null, url?: string | null) =>
    (contentType ?? "").toLowerCase().includes("pdf") ||
    (url ?? "").toLowerCase().endsWith(".pdf"),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, unknown>) => (p?.defaultValue as string) ?? k,
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));

import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";

const IMAGE_URL = "https://example.invalid/storage/v1/object/public/receipts/temp/u1/a.png";
const EXPENSE_ID = "11111111-2222-3333-4444-555555555555";

/**
 * The failure mode was an uncaught ReferenceError, which jsdom surfaces as an
 * `error` event rather than a rejected promise. Capturing it here means a
 * regression fails loudly instead of being swallowed by the effect.
 */
let uncaught: Error[] = [];
const onError = (e: ErrorEvent) => {
  uncaught.push(e.error ?? new Error(e.message));
};

beforeEach(() => {
  // jsdom implements neither; the component revokes blob URLs on cleanup.
  if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => "blob:stub");
  if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  uncaught = [];
  resolveImage.mockReset();
  resolvePdf.mockReset();
  resolveImage.mockResolvedValue("blob:preview");
  resolvePdf.mockResolvedValue("blob:preview");
  window.addEventListener("error", onError);
});

afterEach(() => {
  window.removeEventListener("error", onError);
});

function renderDialog(props: Record<string, unknown> = {}) {
  return render(
    <AttachmentPreviewDialog
      open
      onOpenChange={vi.fn()}
      url={IMAGE_URL}
      contentType="image/png"
      {...props}
    />,
  );
}

describe("expenseId is not defined — PESOWISE-WEB-KF", () => {
  it("opens a preview with NO expenseId prop without throwing", async () => {
    // This is the exact /expenses/new shape: the caller passes no expenseId,
    // which is precisely when the free identifier used to be evaluated.
    renderDialog();
    await waitFor(() => expect(resolveImage).toHaveBeenCalled());
    expect(uncaught).toEqual([]);
  });

  it("opens a preview WITH an expenseId without throwing", async () => {
    renderDialog({ expenseId: EXPENSE_ID });
    await waitFor(() => expect(resolveImage).toHaveBeenCalled());
    expect(uncaught).toEqual([]);
  });

  it("forwards the prop as fallbackExpenseId rather than reading a global", async () => {
    renderDialog({ expenseId: EXPENSE_ID, uploadedBy: "user-1" });
    await waitFor(() => expect(resolveImage).toHaveBeenCalled());
    const options = resolveImage.mock.calls[0][2] as Record<string, unknown>;
    expect(options.fallbackExpenseId).toBe(EXPENSE_ID);
    expect(options.fallbackTempUserId).toBe("user-1");
  });

  it("passes undefined — not a stray global — when the caller omits it", async () => {
    renderDialog({ uploadedBy: "user-1" });
    await waitFor(() => expect(resolveImage).toHaveBeenCalled());
    const options = resolveImage.mock.calls[0][2] as Record<string, unknown>;
    expect(options.fallbackExpenseId).toBeUndefined();
  });

  it("takes the pdf path without throwing either", async () => {
    // Which resolver the component picks for a PDF is its own concern; what
    // matters here is that neither branch evaluates a free identifier.
    renderDialog({ contentType: "application/pdf", expenseId: EXPENSE_ID });
    await waitFor(() =>
      expect(resolvePdf.mock.calls.length + resolveImage.mock.calls.length).toBeGreaterThan(0),
    );
    expect(uncaught).toEqual([]);
  });

  it("survives a preview resolution failure without an uncaught error", async () => {
    // A failed preview must degrade, not crash the New Expense page.
    resolveImage.mockRejectedValue(new Error("Failed to fetch"));
    renderDialog();
    await waitFor(() => expect(resolveImage).toHaveBeenCalled());
    await waitFor(() => expect(uncaught).toEqual([]));
  });

  it("unmounting mid-resolution does not throw", async () => {
    let release: (v: unknown) => void = () => undefined;
    resolveImage.mockImplementation(() => new Promise((r) => { release = r; }));
    const { unmount } = renderDialog();
    await waitFor(() => expect(resolveImage).toHaveBeenCalled());
    unmount();
    release("blob:late");
    await waitFor(() => expect(uncaught).toEqual([]));
  });
});

describe("every attachment preview caller destructures what it reads", () => {
  it("AttachmentPreviewDialog and AttachmentThumbnail both bind expenseId", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    for (const file of [
      "src/components/AttachmentPreviewDialog.tsx",
      "src/components/AttachmentThumbnail.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), file), "utf-8");
      // If a component reads `fallbackExpenseId: expenseId`, the identifier must
      // appear in its destructuring list, not only in the props type.
      if (!src.includes("fallbackExpenseId: expenseId")) continue;
      const destructure = src.slice(src.indexOf("({"), src.indexOf("}:"));
      expect(destructure, `${file} reads expenseId without destructuring it`).toMatch(
        /^\s*expenseId\s*,/m,
      );
    }
  });
});
