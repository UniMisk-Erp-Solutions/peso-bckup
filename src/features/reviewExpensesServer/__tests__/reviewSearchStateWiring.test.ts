/**
 * EngineerReview server-filtered search + workspace-state wiring (DOC-080
 * §2-§9, §12-§22, §34). Source-level guards so the efficiency + restoration
 * wiring cannot silently regress.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(resolve(process.cwd(), "src/pages/EngineerReview.tsx"), "utf-8");

describe("server-query search (true page-at-a-time, submit-driven)", () => {
  it("uses the page-at-a-time transport, not the old 300-row pre-download", () => {
    // The bounded pre-download walker is gone; each page is one queue RPC (§22).
    expect(src).not.toMatch(/fetchFilteredReviewExpenses/);
    expect(src).toMatch(/fetchServerQueryPage\(/);
    expect(src).toMatch(/fetchServerQueryPageByNumber\(/);
    expect(src).toMatch(/buildServerQueryParams/);
    expect(src).toMatch(/SERVER_QUERY_PAGE_SIZE/);
  });

  it("does NOT Load-All the whole scope when an employee is selected", () => {
    // The old effect `if (selectedEmployeeUserId && !allExpensesLoaded ...) handleLoadAllExpenses()` is gone.
    expect(src).not.toMatch(/selectedEmployeeUserId\s*&&\s*!allExpensesLoaded\s*&&\s*!loadingAllExpenses/);
  });

  it("the normal full-scope fetch is skipped while server-query mode is active (broadened)", () => {
    expect(src).toMatch(/if \(reviewFilterActive\) return;/);
    // Mode is now the BROADENED server-query predicate (status/sort/time/custom
    // all activate it), not just employee || generalSearch (§14).
    expect(src).toMatch(/const serverQueryActive = useMemo\(\(\) => isServerQueryActive\(appliedQuery\)/);
    expect(src).toMatch(/const reviewFilterActive = serverQueryActive;/);
  });

  it("filter controls write to DRAFT state, applied only on Search (§7/§8)", () => {
    expect(src).toMatch(/value=\{draftStatus\} onValueChange=\{setDraftStatus\}/);
    expect(src).toMatch(/value=\{draftSortBy\} onValueChange=\{setDraftSortBy\}/);
    expect(src).toMatch(/value=\{draftTimePeriod\} onValueChange=\{setDraftTimePeriod\}/);
    expect(src).toMatch(/onSubmit=\{handleSubmitReviewQuery\}/);
    // The single submit coordinator commits the whole draft at once + bumps revision.
    expect(src).toMatch(/const commitDraftFilters = \(\) => \{/);
    expect(src).toMatch(/setAppliedRevision\(\(r\) => r \+ 1\)/);
  });
});

describe("workspace state save/restore", () => {
  it("saves the workspace and marks return-intent before navigating to a batch", () => {
    expect(src).toMatch(/saveWorkspaceBeforeLeaving\(/);
    expect(src).toMatch(/markReviewReturnPending\(\)/);
    // navigateToBatchReview persists before navigate.
    const navIdx = src.indexOf("const navigateToBatchReview");
    const body = src.slice(navIdx, navIdx + 400);
    expect(body).toMatch(/saveWorkspaceBeforeLeaving\(expenseId\)/);
    expect(body.indexOf("saveWorkspaceBeforeLeaving")).toBeLessThan(body.indexOf("navigate(`/expenses/batch"));
  });

  it("restore is gated on the one-shot return-intent marker (no sidebar trap)", () => {
    expect(src).toMatch(/if \(!consumeReviewReturnPending\(\)\) return;/);
    expect(src).toMatch(/loadReviewWorkspaceState\(organizationId, user\.id/);
  });

  it("restores the employee from the stored user_id — no employee-search RPC", () => {
    // restoreSearch is used with the stored identity; searchReviewEmployees is not called on restore.
    expect(src).toMatch(/singleBar\.restoreSearch\(\{/);
    const restoreIdx = src.indexOf("consumeReviewReturnPending");
    const block = src.slice(restoreIdx, restoreIdx + 1200);
    expect(block).not.toMatch(/searchReviewEmployees|singleBar\.submit\(/);
  });

  it("clamps the restored page to the fresh result", () => {
    expect(src).toMatch(/clampRestoredPage\(snap\.pagination\.page/);
  });

  it("carries a scroll/anchor target and restores by expense row", () => {
    expect(src).toMatch(/data-expense-id=\{expense\.id\}/);
    expect(src).toMatch(/\[data-expense-id="\$\{ws\.anchorExpenseId\}"\]/);
  });
});
