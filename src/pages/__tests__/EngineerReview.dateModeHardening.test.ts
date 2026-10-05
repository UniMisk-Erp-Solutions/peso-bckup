/**
 * Source-contract checks for the §14-21 Month/Time-Period mutual-exclusion
 * hardening pass. EngineerReview.tsx has no render harness (see
 * EngineerReview.expenseMonthFilter.test.ts's header for why), so this file
 * proves the PAGE wires in the fix the same way EngineerReview.expenseMonthFilter.test.ts
 * proves the original month-filter wiring. The mutual-exclusion CONTRACT
 * itself -- does a multi-step interaction ever clobber Month or an unrelated
 * draft -- is proven behaviorally against the equivalent pure model in
 * src/lib/__tests__/reviewDateMode.test.ts (§33 requires real behavioral
 * proof for this, not a source-text assertion).
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
  const nextDeclIdx = source.indexOf("\n  const ", declIdx + 1);
  return source.slice(declIdx, nextDeclIdx === -1 ? source.length : nextDeclIdx);
}

describe("the mirror effect is split into eight independent, single-dependency effects (§14-16)", () => {
  it("each applied field syncs its OWN draft twin in its own effect, not one effect depending on all eight", () => {
    const pairs: [string, string][] = [
      ["setDraftStatus(statusFilter);", "[statusFilter]"],
      ["setDraftSortBy(sortBy);", "[sortBy]"],
      ["setDraftSortOrder(sortOrder);", "[sortOrder]"],
      ["setDraftTimePeriod(timePeriod);", "[timePeriod]"],
      ["setDraftShowOnlyActionable(showOnlyActionable);", "[showOnlyActionable]"],
      ["setDraftIncludeTeamLeaderReports(includeTeamLeaderReports);", "[includeTeamLeaderReports]"],
      ["setDraftIncludeExecutiveReports(includeExecutiveReports);", "[includeExecutiveReports]"],
      ["setDraftCustomFieldFilters(customFieldFilters);", "[customFieldFilters]"],
    ];
    for (const [setter, deps] of pairs) {
      const setterIdx = source.indexOf(setter);
      expect(setterIdx, `${setter} not found`).toBeGreaterThan(-1);
      // The effect containing this setter must close with EXACTLY this one
      // dependency -- i.e. `}, [statusFilter]);` right after it, not a
      // multi-field dependency array.
      const closeIdx = source.indexOf("}, " + deps + ");", setterIdx);
      expect(closeIdx, `${setter} is not in a single-dependency effect closing with }, ${deps});`).toBeGreaterThan(-1);
      expect(closeIdx - setterIdx).toBeLessThan(80);
    }
  });

  it("no single effect depends on more than one of the eight applied fields (the old clobbering shape)", () => {
    const mirrorIdx = source.indexOf("Mirror each draft twin to its OWN matching applied field");
    expect(mirrorIdx).toBeGreaterThan(-1);
    const blockEnd = source.indexOf("}, [customFieldFilters]);", mirrorIdx);
    const block = source.slice(mirrorIdx, blockEnd + 30);
    // A combined dependency array would look like `}, [statusFilter, sortBy`
    expect(block).not.toMatch(/\}, \[\s*\w+,\s*\w+/);
  });
});

describe("handleExpenseMonthChange forces the relative period to 'all' directly (§14-18 fix)", () => {
  it("calls setTimePeriod(\"all\") -- the actual fix that keeps draftTimePeriod from ever going stale", () => {
    const body = fnBody("handleExpenseMonthChange");
    expect(body).toContain("setExpenseMonth(value as ExpenseMonthValue)");
    expect(body).toContain('setTimePeriod("all")');
  });

  it("still never touches any OTHER draft state directly (only the narrow mirror effect may)", () => {
    const body = fnBody("handleExpenseMonthChange");
    expect(body).not.toMatch(/setDraft[A-Z]/);
    expect(body).not.toContain("setAppliedRevision");
  });
});

describe("handleReviewTimePeriodChange -- mobile's immediate-apply Time Period enforces the same mutual exclusion (§19-21)", () => {
  it("exists, sets timePeriod, and resets Month to ALL_MONTHS for any non-'all' value", () => {
    const body = fnBody("handleReviewTimePeriodChange");
    expect(body).toContain("setTimePeriod(value)");
    expect(body).toMatch(/if \(value !== "all"\) \{\s*setExpenseMonth\(ALL_MONTHS\);\s*\}/);
  });

  it("resets server pagination and the bulk selection, matching every other applied-filter change", () => {
    const body = fnBody("handleReviewTimePeriodChange");
    expect(body).toContain("serverPageRef.current = 1");
    expect(body).toContain("setServerPage(1)");
    expect(body).toContain("setCurrentPage(1)");
    expect(body).toContain("setSelectedKeys(new Set())");
  });

  it("MobileReviewQueueView receives this handler, not the raw setTimePeriod setter", () => {
    const idx = source.indexOf("<MobileReviewQueueView");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("/>", idx));
    expect(block).toContain("setTimePeriod={handleReviewTimePeriodChange}");
    expect(block).not.toContain("setTimePeriod={setTimePeriod}");
  });
});
