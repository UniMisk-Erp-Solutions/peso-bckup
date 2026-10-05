/**
 * Exact MONTH+YEAR filtering on My Expenses (expenses.trip_start).
 *
 * Expenses.tsx has no render-test harness (same situation as
 * EngineerReview.tsx -- see EngineerReview.expenseTableDensity.test.ts):
 * its data pipeline needs far more Supabase query-builder mocking than the
 * shared test setup provides, so this file reads source directly to prove
 * the PAGE wires the already-unit-tested pure logic in correctly. The
 * underlying month-bounds/option-generation logic is covered by real unit
 * tests in expenseMonthFilter.test.ts; the new server RPC itself was
 * proven correct, secure, and boundary-exact via a rolled-back transaction
 * against real Production data (see the MY EXPENSES section of the final
 * report) -- NOT applied to Production pending owner approval.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(process.cwd(), "src/pages/Expenses.tsx"), "utf-8").replace(
  /\r\n/g,
  "\n",
);

function fnBody(name: string): string {
  const declIdx = source.indexOf(`const ${name} = `);
  expect(declIdx, `${name} not found`).toBeGreaterThan(-1);
  const nextDeclIdx = source.indexOf("\n  const ", declIdx + 1);
  return source.slice(declIdx, nextDeclIdx === -1 ? source.length : nextDeclIdx);
}

describe("expenseMonth state -- applies immediately, default unchanged", () => {
  it("defaults to ALL_MONTHS", () => {
    expect(source).toMatch(/const \[expenseMonth, setExpenseMonth\] = useState<ExpenseMonthValue>\(ALL_MONTHS\)/);
  });
});

describe("the existing client-filter effect never overwrites month-mode results (§26)", () => {
  it("bails out early when isExactMonthMode, and re-runs when it flips back to false", () => {
    const idx = source.indexOf("if (isExactMonthMode) return;\n    filterAndSortExpenses();");
    expect(idx).toBeGreaterThan(-1);
    const effectBlock = source.slice(source.lastIndexOf("useEffect(", idx), source.indexOf("}, [", idx) + 200);
    expect(effectBlock).toContain("isExactMonthMode");
  });
});

describe("fetchMyExpensesMonthPage -- calls the new RPC with no client-supplied user_id (§33 security)", () => {
  it("calls get_my_expenses_page_v1 and never passes a p_user_id parameter", () => {
    const body = fnBody("fetchMyExpensesMonthPage");
    expect(body).toContain('"get_my_expenses_page_v1"');
    expect(body).not.toContain("p_user_id");
  });

  it("passes organizationId, half-open month bounds, and the current status/search/sort/custom filters", () => {
    const body = fnBody("fetchMyExpensesMonthPage");
    expect(body).toContain("p_organization_id: organizationId");
    expect(body).toContain("p_date_from: bounds.from");
    expect(body).toContain("p_date_to_exclusive: bounds.toExclusive");
    expect(body).toContain("p_status: statusFilter");
    expect(body).toContain("p_search: searchTerm.trim() || null");
    expect(body).toContain("p_sort_by: sortBy");
    expect(body).toContain("p_sort_order: sortOrder");
    expect(body).toContain("p_custom_filters: customFiltersArr");
  });

  it("degrades to a visible error state rather than throwing, and never on a superseded/aborted request", () => {
    // The actual stale/aborted-vs-error decision is made by runMonthFetch
    // (src/lib/monthFetchGuard.ts), which is real-behavior tested with
    // deferred promises in monthFetchGuard.test.ts -- §33 requires that,
    // since a source-text assertion alone cannot prove a race is closed.
    const body = fnBody("fetchMyExpensesMonthPage");
    expect(body).toContain("runMonthFetch(");
    expect(body).toContain('outcome.kind === "stale" || outcome.kind === "aborted"');
    expect(body).toContain("setMonthModeError(");
  });
});

describe("month range discovery -- two 1-row queries, never a full scan (§30 analog for My Expenses)", () => {
  it("queries earliest and latest trip_start for THIS user/org only", () => {
    const idx = source.indexOf("Discover the Month dropdown's calendar range");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("[user?.id, organizationId]);", idx));
    expect(block).toContain('.eq("user_id", user.id)');
    expect(block).toContain('.eq("organization_id", organizationId)');
    expect(block).toContain(".limit(1)");
  });

  it("does NOT exclude drafts (§10-11 parity): All-months' own fetch never excludes them either", () => {
    const idx = source.indexOf("Discover the Month dropdown's calendar range");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("[user?.id, organizationId]);", idx));
    expect(block).not.toContain('.neq("status", "draft")');
  });
});

describe("draft population parity -- All-months never excludes drafts, so exact-month must not either (§10-11)", () => {
  it("fetchExpenses' base query has no status filter at all (drafts are part of the base list)", () => {
    const idx = source.indexOf("const fetchExpenses = async");
    expect(idx).toBeGreaterThan(-1);
    const endIdx = source.indexOf("const handleLoadAllExpenses", idx);
    const block = source.slice(idx, endIdx === -1 ? source.length : endIdx);
    expect(block).not.toContain('.neq("status"');
    expect(block).not.toContain(".eq(\"status\"");
  });

  it("filterAndSortExpenses never filters out status='draft' rows", () => {
    const idx = source.indexOf("const filterAndSortExpenses = ()");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("setFilteredExpenses(filtered);", idx));
    expect(block).not.toMatch(/draft/i);
  });
});

describe("page reset semantics (§28/§61)", () => {
  it("handleExpenseMonthChange sets expenseMonth and resets monthModePage to 1", () => {
    const body = fnBody("handleExpenseMonthChange");
    expect(body).toContain("setExpenseMonth(value as ExpenseMonthValue)");
    expect(body).toContain("setMonthModePage(1)");
  });

  it("changing status/search/sort/custom filters while a month is selected also resets to page 1", () => {
    const idx = source.indexOf("Any OTHER filter change while a month is selected");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("]);", idx) + 3);
    expect(block).toContain("if (!isExactMonthMode) return;");
    expect(block).toContain("setMonthModePage(1);");
    expect(block).toContain("statusFilter");
    expect(block).toContain("searchTerm");
    expect(block).toContain("sortBy");
    expect(block).toContain("sortOrder");
    expect(block).toContain("customFieldFilters");
  });
});

describe("Load-all is suppressed in exact-month mode (§40)", () => {
  it("the month-mode render branch never references handleLoadAllExpenses/Load-all copy", () => {
    const idx = source.indexOf("{isExactMonthMode ? (");
    expect(idx).toBeGreaterThan(-1);
    const monthBranchEnd = source.indexOf(") : (", idx);
    const monthBranch = source.slice(idx, monthBranchEnd);
    expect(monthBranch).not.toContain("handleLoadAllExpenses");
    expect(monthBranch).not.toContain("Load all");
  });
});

describe("CSV export is disabled (not silently partial) in exact-month mode (§41)", () => {
  it("the export button is disabled while a month is selected, with a truthful explanation", () => {
    const idx = source.indexOf("onClick={exportExpenses}");
    expect(idx).toBeGreaterThan(-1);
    const buttonBlock = source.slice(source.lastIndexOf("<Button", idx), source.indexOf(">", idx) + 1);
    expect(buttonBlock).toContain("disabled={isExactMonthMode}");
    expect(buttonBlock).toMatch(/title=\{[\s\S]*isExactMonthMode/);
  });
});

describe("Drafts tab is unaffected -- Month lives only inside the 'all' TabsContent (§42)", () => {
  it("the Month Select is declared after the 'all' TabsContent opens and before it closes", () => {
    const tabsAllIdx = source.indexOf('<TabsContent value="all"');
    const monthSelectIdx = source.indexOf('aria-label="Month"');
    const draftsTabIdx = source.indexOf('<TabsContent value="drafts"');
    expect(tabsAllIdx).toBeGreaterThan(-1);
    expect(monthSelectIdx).toBeGreaterThan(tabsAllIdx);
    // Drafts tab content is declared separately and does not reference expenseMonth at all.
    const draftsBlock = source.slice(draftsTabIdx, source.indexOf("</TabsContent>", draftsTabIdx));
    expect(draftsBlock).not.toContain("expenseMonth");
  });
});

describe("mobile wiring reuses the SAME page state, not a second filter model (§43)", () => {
  it("MobileExpenseListView receives expenseMonth/monthOptions/month-mode pagination from this page's own state", () => {
    const idx = source.indexOf("<MobileExpenseListView");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, source.indexOf("/>", idx));
    expect(block).toContain("expenseMonth={expenseMonth}");
    expect(block).toContain("monthOptions={monthOptions}");
    expect(block).toContain("onExpenseMonthChange={handleExpenseMonthChange}");
    expect(block).toContain("monthModePage={monthModePage}");
    expect(block).toContain("monthModeTotalPages={monthModeTotalPages}");
  });
});
