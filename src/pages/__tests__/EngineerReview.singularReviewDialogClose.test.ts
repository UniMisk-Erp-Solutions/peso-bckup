/**
 * Hotfix: singular Expense Review dialog stayed open (empty shell) after a
 * successful Verify/Approve/Reject.
 *
 * Root cause: the desktop singular dialog was an UNCONTROLLED <Dialog> --
 * DialogTrigger's own click handler flipped Radix's internal open state to
 * true, but nothing ever told Radix to flip it back to false. Clearing
 * `selectedExpense` on success only emptied the dialog's content (the
 * `{selectedExpense && (...)}` block), leaving the DialogHeader/DialogFooter
 * shell visibly open -- exactly the owner-reported screenshot. The same gap
 * meant the desktop Cancel button, and Escape/outside-click (Radix's own
 * behavior, unwired to any of our state), would have left the same shell or
 * a stale `selectedExpense` behind.
 *
 * Fix: the dialog is now CONTROLLED by the same identity that already
 * represents "which expense is open" -- `open={selectedExpense?.id ===
 * expense.id}` -- with `onOpenChange` and every terminal/manual-close path
 * funneled through one `resetSelectedExpenseReview()` helper.
 *
 * See EngineerReview.expenseTableDensity.test.ts for why this file reads
 * source directly instead of mounting the page: EngineerReview.tsx has no
 * render-test harness (its data pipeline -- local cache, snapshots, server
 * pagination, legacy fallback -- needs far more Supabase query-builder
 * mocking than the shared test setup provides), so a real render-and-click
 * repro is not practical here. The actual Radix controlled-dialog mechanism
 * this fix relies on (open bound to an identity comparison, reset funneled
 * through onOpenChange) is instead proven against real Radix + jsdom in
 * EngineerReview.singularReviewDialogLifecycle.test.tsx, in isolation from
 * this page's data pipeline.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/EngineerReview.tsx"),
  "utf-8",
).replace(/\r\n/g, "\n");

function fnBody(name: string): string {
  const declIdx = source.indexOf(`const ${name} = `);
  expect(declIdx, `${name} not found`).toBeGreaterThan(-1);
  // Slice out this function up to the next top-level `const <identifier> = `
  // declaration (2-space indent), which reliably marks the next sibling.
  const nextDeclIdx = source.indexOf("\n  const ", declIdx + 1);
  return source.slice(declIdx, nextDeclIdx === -1 ? source.length : nextDeclIdx);
}

describe("resetSelectedExpenseReview -- the single shared close/cleanup helper", () => {
  const helper = fnBody("resetSelectedExpenseReview");

  it("clears every piece of transient singular-review state", () => {
    expect(helper).toContain("setSelectedExpense(null)");
    expect(helper).toContain('setEngineerComment("")');
    expect(helper).toContain("setLineItems([])");
    expect(helper).toContain("setAttachments([])");
    expect(helper).toContain("setAuditLogs([])");
    expect(helper).toContain("setCorrectionLogs([])");
    expect(helper).toContain("setTimelineAssignees({})");
    expect(helper).toContain("setCorrectionDialogOpen(false)");
  });

  it("does not touch filters, pagination, bulk selection, or review-queue state", () => {
    for (const untouched of [
      "setSearchTerm",
      "setStatusFilter",
      "setCurrentPage",
      "setServerPage",
      "setSelectedKeys",
      "setExpenses",
      "setAllExpenses",
      "setTimePeriod",
    ]) {
      expect(helper).not.toContain(`${untouched}(`);
    }
  });
});

describe("desktop singular Dialog is controlled by selectedExpense identity", () => {
  const dialogOpenIdx = source.indexOf("open={selectedExpense?.id === expense.id}");

  it("binds `open` to selectedExpense?.id === expense.id (no per-row boolean state)", () => {
    expect(dialogOpenIdx).toBeGreaterThan(-1);
    expect(source).not.toMatch(/const \[dialogOpen, setDialogOpen\]/);
  });

  it("onOpenChange(false) runs resetSelectedExpenseReview -- covers manual X, Escape, and outside-click uniformly", () => {
    const onOpenChangeBlock = source.slice(dialogOpenIdx, source.indexOf("</Dialog>", dialogOpenIdx));
    expect(onOpenChangeBlock).toMatch(/onOpenChange=\{\(open\) => \{\s*if \(!open\) resetSelectedExpenseReview\(\);\s*\}\}/);
  });

  it("the DialogTrigger's onClick still opens by selecting the expense and loading its details (opening behavior unchanged)", () => {
    const triggerBlock = source.slice(dialogOpenIdx, source.indexOf("</DialogTrigger>", dialogOpenIdx));
    expect(triggerBlock).toContain("setSelectedExpense(expense)");
    expect(triggerBlock).toContain("fetchExpenseDetails(expense.id, expense)");
    expect(triggerBlock).toContain("fetchEngineerApprovalLimit()");
  });

  it("manual Cancel button calls the shared reset helper directly", () => {
    const footerIdx = source.indexOf("<DialogFooter", dialogOpenIdx);
    const cancelBlock = source.slice(footerIdx, footerIdx + 400);
    expect(cancelBlock).toContain('variant="outline"');
    expect(cancelBlock).toContain("onClick={resetSelectedExpenseReview}");
    expect(cancelBlock).toContain(">\n                                      Cancel");
  });
});

describe("terminal singular actions close the dialog on success, stay open on failure", () => {
  for (const action of ["verifyExpense", "approveExpense", "rejectExpense"] as const) {
    it(`${action}: success path calls resetSelectedExpenseReview, catch/failure path does not`, () => {
      const body = fnBody(action);
      const tryIdx = body.indexOf("try {");
      const catchIdx = body.indexOf("} catch");
      expect(tryIdx, `${action} has no try block`).toBeGreaterThan(-1);
      expect(catchIdx, `${action} has no catch block`).toBeGreaterThan(tryIdx);

      const successPath = body.slice(tryIdx, catchIdx);
      const catchBlock = body.slice(catchIdx, body.indexOf("} finally", catchIdx) === -1 ? body.length : body.indexOf("} finally", catchIdx));

      expect(successPath, `${action}'s success path must close the dialog via the shared helper`).toContain(
        "resetSelectedExpenseReview()",
      );
      expect(catchBlock, `${action} must NOT close the dialog on failure -- the user's loaded expense and input must remain visible`).not.toContain(
        "resetSelectedExpenseReview()",
      );
      expect(catchBlock, `${action} must NOT clear selectedExpense on failure`).not.toContain("setSelectedExpense(null)");
    });
  }

  it("approveExpense keeps its extra evictSettledReviewRows call alongside the shared reset (not folded into it)", () => {
    const body = fnBody("approveExpense");
    const resetIdx = body.indexOf("resetSelectedExpenseReview()");
    expect(resetIdx).toBeGreaterThan(-1);
    expect(body.slice(resetIdx, resetIdx + 150)).toContain("evictSettledReviewRows(new Set([exp.id]))");
  });
});

describe("mobile detail view reuses the same shared helper for its Back action", () => {
  it("MobileReviewDetailView's onBack is the shared resetSelectedExpenseReview, not a bespoke inline cleanup", () => {
    const onBackIdx = source.indexOf("onBack={resetSelectedExpenseReview}");
    expect(onBackIdx).toBeGreaterThan(-1);
  });

  it("mobile still renders MobileReviewDetailView (not the Radix Dialog) -- confirms mobile is unaffected by this bug and was left alone", () => {
    expect(source).toContain("if (selectedExpense && reviewExpense) {");
    expect(source).toContain("<MobileReviewDetailView");
  });
});

describe("batch review is untouched by this hotfix", () => {
  it("still navigates away instead of opening the singular dialog", () => {
    expect(source).toContain("onClick={() => navigateToBatchReview(expense.batch_id!, expense.id)}");
  });
});
