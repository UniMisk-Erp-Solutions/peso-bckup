/**
 * Exact MONTH+YEAR filtering on Review Expenses (expenses.trip_start).
 *
 * See EngineerReview.expenseTableDensity.test.ts for why this file reads
 * source directly instead of mounting the page: EngineerReview.tsx has no
 * render-test harness (its data pipeline needs far more Supabase
 * query-builder mocking than the shared test setup provides). The underlying
 * pure logic (month bounds, option generation, applied-query identity) is
 * fully covered by real unit tests in expenseMonthFilter.test.ts and
 * reviewAppliedQuery.test.ts; this file proves the PAGE actually wires that
 * logic in correctly -- the exact contract an integration test would check.
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

describe("expenseMonth state -- applied immediately, no draft twin", () => {
  it("defaults to ALL_MONTHS", () => {
    expect(source).toMatch(/const \[expenseMonth, setExpenseMonth\] = useState<ExpenseMonthValue>\(ALL_MONTHS\)/);
  });

  it("has no draftExpenseMonth -- Month never goes through the draft/Search-submit gate", () => {
    expect(source).not.toContain("draftExpenseMonth");
    expect(source).not.toContain("setDraftExpenseMonth");
  });

  it("is NOT one of the fields the applied->draft mirror effects copy (see EngineerReview.dateModeHardening.test.ts for the full narrow-effect contract, §14-18)", () => {
    const mirrorIdx = source.indexOf("Mirror each draft twin to its OWN matching applied field");
    expect(mirrorIdx).toBeGreaterThan(-1);
    const lastMirrorEffectEnd = source.indexOf(
      "}, [customFieldFilters]);",
      mirrorIdx,
    );
    expect(lastMirrorEffectEnd).toBeGreaterThan(-1);
    const effectBlock = source.slice(mirrorIdx, lastMirrorEffectEnd + 30);
    expect(effectBlock).not.toContain("setExpenseMonth");
  });
});

describe("appliedQuery includes expenseMonth (§12)", () => {
  it("the applied query memo carries expenseMonth in both its value and its dependency array", () => {
    const memoIdx = source.indexOf("const appliedQuery: AppliedReviewQuery = useMemo(");
    expect(memoIdx).toBeGreaterThan(-1);
    const memoBlock = source.slice(memoIdx, source.indexOf("  );", memoIdx));
    const occurrences = memoBlock.split("expenseMonth").length - 1;
    // Once in the returned object, once in the dependency array.
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe("buildServerQueryParams -- exact month wins over the relative time period (§11/§13)", () => {
  it("prefers deriveExpenseMonthDateRange when expenseMonth is not 'all', falling back to deriveDateRange otherwise", () => {
    const body = fnBody("buildServerQueryParams");
    expect(body).toContain("applied.expenseMonth !== ALL_MONTHS");
    expect(body).toContain("deriveExpenseMonthDateRange(applied.expenseMonth)");
    expect(body).toContain("deriveDateRange(applied.timePeriod, new Date())");
  });
});

describe("handleExpenseMonthChange -- immediate apply + page reset (§10/§17)", () => {
  it("sets expenseMonth and resets server page, current page, and bulk selection -- exactly like commitDraftFilters", () => {
    const body = fnBody("handleExpenseMonthChange");
    expect(body).toContain("setExpenseMonth(value as ExpenseMonthValue)");
    expect(body).toContain("serverPageRef.current = 1");
    expect(body).toContain("setServerPage(1)");
    expect(body).toContain("setCurrentPage(1)");
    expect(body).toContain("setSelectedKeys(new Set())");
  });

  it("never touches any draft state (would risk committing an unrelated unsaved draft, §10)", () => {
    const body = fnBody("handleExpenseMonthChange");
    expect(body).not.toMatch(/setDraft[A-Z]/);
    expect(body).not.toContain("setAppliedRevision");
  });
});

describe("commitDraftFilters -- deliberately choosing a relative period resets Month (§11)", () => {
  it("resets expenseMonth to ALL_MONTHS only when the committed draftTimePeriod is not 'all'", () => {
    const body = fnBody("commitDraftFilters");
    expect(body).toMatch(/if \(draftTimePeriod !== "all"\) \{\s*setExpenseMonth\(ALL_MONTHS\);\s*\}/);
  });

  it("does not unconditionally reset expenseMonth on every Search submit (would defeat an already-selected month, §62)", () => {
    const body = fnBody("commitDraftFilters");
    const unconditional = /^\s*setExpenseMonth\(ALL_MONTHS\);/m.test(
      body.replace(/if \(draftTimePeriod !== "all"\) \{[^}]*\}/, ""),
    );
    expect(unconditional).toBe(false);
  });
});

describe("month range discovery reuses the canonical Review queue RPC (§23)", () => {
  it("resolves earliest/latest via fetchServerQueryPage sorted expense_date_asc / expense_date_desc, pageSize 1, with no other filters", () => {
    const idx = source.indexOf("Discover the Month dropdown's calendar range");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("[organizationId, user?.id]);", idx));
    expect(block).toContain('sort: "expense_date_asc"');
    expect(block).toContain('sort: "expense_date_desc"');
    expect(block).toContain("pageSize: 1");
    // Never passes employee/status/date/custom filters -- the reviewer's own
    // full accessible scope, not today's other applied filters (§23).
    expect(block).not.toContain("employeeUserId:");
    expect(block).not.toContain("statuses:");
    expect(block).not.toContain("dateFrom:");
    expect(block).not.toContain("customFilters:");
  });

  it("degrades to 'All months' only, never throws, on a fetch failure", () => {
    const idx = source.indexOf("Discover the Month dropdown's calendar range");
    const block = source.slice(idx, source.indexOf("[organizationId, user?.id]);", idx));
    expect(block).toContain("catch (error)");
    expect(block).toMatch(/setMonthOptions\(\[\{ value: ALL_MONTHS, label: "All months" \}\]\)/);
  });
});

describe("cache and workspace identity include expenseMonth (§14/§15/§16)", () => {
  it("buildReviewListCacheKey's signature and body both carry expenseMonth", () => {
    const sigIdx = source.indexOf("function buildReviewListCacheKey(input: {");
    expect(sigIdx).toBeGreaterThan(-1);
    const fnBlock = source.slice(sigIdx, source.indexOf('.join("|");', sigIdx));
    expect(fnBlock).toContain("expenseMonth?: string");
    expect(fnBlock).toContain("input.expenseMonth");
  });

  it("every call site of buildReviewListCacheKey passes expenseMonth", () => {
    const calls = [...source.matchAll(/buildReviewListCacheKey\(\{([\s\S]*?)\}\);/g)];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call[1]).toContain("expenseMonth");
    }
  });

  it("the workspace snapshot (save) includes expenseMonth", () => {
    const idx = source.indexOf("const buildWorkspaceSnapshot");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("pagination: {", idx));
    expect(block).toContain("expenseMonth,");
  });

  it("workspace restore applies expenseMonth to both the live state and the reconstructed applied-query used for the return-cache key", () => {
    const restoreIdx = source.indexOf("setTimePeriod(snap.query.timePeriod);");
    expect(restoreIdx).toBeGreaterThan(-1);
    const restoreBlock = source.slice(restoreIdx, restoreIdx + 200);
    expect(restoreBlock).toContain("setExpenseMonth(snap.query.expenseMonth)");

    const reconstructIdx = source.indexOf("const restoredApplied = defaultAppliedReviewQuery({");
    expect(reconstructIdx).toBeGreaterThan(-1);
    const reconstructBlock = source.slice(reconstructIdx, source.indexOf("});", reconstructIdx));
    expect(reconstructBlock).toContain("expenseMonth: snap.query.expenseMonth");
  });
});

describe("empty-state copy for a zero-result exact month (§22/§48)", () => {
  it("shows the month-specific empty state before falling through to the generic one", () => {
    expect(source).toContain(
      "expenses.length === 0 && expenseMonth !== ALL_MONTHS",
    );
    expect(source).toMatch(/No review expenses found for \{formatExpenseMonthLabel\(expenseMonth\)\}\./);
  });
});

describe("mobile Month wiring (§43) -- reuses the same state, not a second filter model", () => {
  it("MobileReviewQueueView receives expenseMonth/monthOptions/onExpenseMonthChange from the SAME page state", () => {
    const idx = source.indexOf("<MobileReviewQueueView");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("/>", idx));
    expect(block).toContain("expenseMonth={expenseMonth}");
    expect(block).toContain("monthOptions={monthOptions}");
    expect(block).toContain("onExpenseMonthChange={handleExpenseMonthChange}");
  });
});

describe("batch review is untouched by month filtering", () => {
  it("still navigates away instead of routing batch rows through the month-filtered dialog/query", () => {
    expect(source).toContain("onClick={() => navigateToBatchReview(expense.batch_id!, expense.id)}");
  });
});
