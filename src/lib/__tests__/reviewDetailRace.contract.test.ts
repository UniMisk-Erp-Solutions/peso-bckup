/**
 * The review screens keep their fetches inline. These contracts lock the late-response
 * checks and the immediate clear so a future edit cannot put expense A's detail back
 * onto expense B. Behaviour of the shared helpers is covered in latestRequestGuard.test.ts
 * and the attachment/preview hook tests.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8").replace(/\r\n/g, "\n");
}

function fnBody(source: string, name: string): string {
  const declIdx = source.indexOf(`const ${name} = `);
  expect(declIdx, `${name} not found`).toBeGreaterThan(-1);
  const nextDeclIdx = source.indexOf("\n  const ", declIdx + 1);
  return source.slice(declIdx, nextDeclIdx === -1 ? source.length : nextDeclIdx);
}

const admin = read("src/pages/AdminPanel.tsx");
const review = read("src/pages/EngineerReview.tsx");
const detail = read("src/features/reviewExpensesServer/ReviewExpenseDetail.tsx");

describe("AdminPanel expense-scoped detail", () => {
  const audit = fnBody(admin, "fetchAuditLogs");
  const corrections = fnBody(admin, "fetchCorrectionLogs");

  it("resets audit and correction state when the selected expense changes, before the effect fetches", () => {
    expect(admin).toContain("applyExpenseScopeChange");
    expect(admin).toContain("auditGuardRef.current.invalidate()");
    expect(admin).toContain("correctionGuardRef.current.invalidate()");
    expect(admin).toContain('setAuditStatus(selectedExpenseId ? "loading" : "idle")');
    expect(admin).toContain('setCorrectionStatus(selectedExpenseId ? "loading" : "idle")');
    expect(admin).toContain("setAuditLogs([])");
    expect(admin).toContain("setCorrectionLogs([])");
  });

  it("checks the active expense before every audit or correction write", () => {
    for (const write of ["setAuditLogs(enrichedLogs)", "setTimelineAssignees({", "setAuditStatus(\"error\")"]) {
      expect(audit).toContain("responseStillCurrent");
      expect(audit).toContain(write);
    }
    expect(audit).toContain("if (!accept()) return;");
    expect(corrections).toContain("if (!accept()) return;");
    expect(corrections).toContain("setCorrectionLogs([])");
    expect(corrections).toContain('setCorrectionStatus("error")');
  });

  it("loads attachments and preview through the expense-scoped hooks", () => {
    expect(admin).toContain("useExpenseAttachments<Attachment>");
    expect(admin).toContain("useExpensePreview(selectedExpense?.id ?? null)");
    expect(admin).not.toContain("Date.now()");
  });
});

describe("EngineerReview expense-scoped detail", () => {
  const fetchDetails = fnBody(review, "fetchExpenseDetails");
  const reset = fnBody(review, "resetSelectedExpenseReview");

  it("clears line items, timeline and corrections when the expense id changes and shows loading", () => {
    expect(fetchDetails).toContain("setLineItems([])");
    expect(fetchDetails).toContain("setAuditLogs([])");
    expect(fetchDetails).toContain("setCorrectionLogs([])");
    expect(fetchDetails).toContain('setDetailStatus("loading")');
    expect(fetchDetails).toContain("responseStillCurrent");
    expect(fetchDetails).toContain("if (!accept()) return;");
    expect(fetchDetails).toContain('setDetailStatus("error")');
    expect(review).toContain('data-testid="line-items-loading"');
    expect(review).toContain('data-testid="expense-detail-error"');
  });

  it("invalidates an in-flight detail request when the review closes", () => {
    expect(reset).toContain("detailGuardRef.current.invalidate()");
    expect(reset).toContain("detailOwnerRef.current = null");
    expect(reset).toContain("setLineItems([])");
    expect(reset).toContain("setSelectedExpense(null)");
    expect(review).toContain("resetSelectedExpenseReview()");
  });

  it("does not cache-bust receipt urls", () => {
    const loader = fnBody(review, "loadAttachmentsForExpense");
    expect(loader).not.toContain("?timestamp=");
    expect(loader).not.toContain("Date.now()");
    expect(review).toContain("useExpenseAttachments<Attachment>");
    expect(review).toContain("useExpensePreview(selectedExpense?.id ?? null)");
  });
});

describe("ReviewExpenseDetail preview", () => {
  it("binds the preview to the expense id on screen", () => {
    expect(detail).toContain("useExpensePreview(expenseId)");
    expect(detail).toContain("url={preview.url}");
    expect(detail).toContain("open={preview.open}");
  });
});
