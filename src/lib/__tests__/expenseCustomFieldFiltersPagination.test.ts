/**
 * DOC-100 pt.3 — fetchFilterableCustomFieldDefinitions must never trust a
 * single unpaged request to return every row (PostgREST silently caps
 * unpaged selects, which is the exact failure mode this whole hotfix
 * branch exists to close).
 *
 * FCF-1  paginates expense_form_field_option_branches across multiple pages
 *        instead of a single unbounded request
 * FCF-2  still returns the correct de-duplicated field list once every page
 *        has been consumed
 * FCF-3  every request carries a .range() call (bounded page size), never
 *        an un-ranged full-table select
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));

import { supabase } from "@/integrations/supabase/client";
import { fetchFilterableCustomFieldDefinitions } from "@/lib/expenseCustomFieldFilters";

/** Simulate a table with `total` rows, served `pageSize` at a time, tracking
 *  every .range() call made against it. */
function makePagedTable(total: number, rowFactory: (i: number) => Record<string, unknown>, pageSize = 1000) {
  const rangeCalls: Array<[number, number]> = [];
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.range = vi.fn((from: number, to: number) => {
    rangeCalls.push([from, to]);
    const rows = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push(rowFactory(i));
    return Promise.resolve({ data: rows, error: null });
  });
  return { chain, rangeCalls };
}

describe("FCF-1/FCF-3 — auto-paged, bounded requests", () => {
  it("issues multiple bounded .range() calls to fully drain a >1-page table", async () => {
    // 1500 branch rows -> must take 2 pages at pageSize 1000.
    const branchTable = makePagedTable(1500, (i) => ({
      id: `b${i}`,
      name: `Field ${i}`,
      field_type: "select",
      options: ["x"],
    }));
    const emptyTable = makePagedTable(0, () => ({}));

    (supabase.from as any).mockImplementation((table: string) => {
      if (table === "expense_form_field_option_branches") return branchTable.chain;
      return emptyTable.chain;
    });

    const result = await fetchFilterableCustomFieldDefinitions("org-1");

    expect(branchTable.rangeCalls.length).toBeGreaterThanOrEqual(2);
    expect(branchTable.rangeCalls[0]).toEqual([0, 999]);
    expect(branchTable.rangeCalls[1][0]).toBe(1000);
    // FCF-2: every distinct field name across both pages made it into the result.
    expect(result.length).toBe(1500);
    expect(result.map((f) => f.label)).toContain("Field 0");
    expect(result.map((f) => f.label)).toContain("Field 1499");
  });
});

describe("FCF-3 — single-page table still ranges (never an un-ranged select)", () => {
  it("calls .range() even when everything fits on page 1", async () => {
    const table = makePagedTable(3, (i) => ({
      id: `t${i}`,
      name: `T${i}`,
      field_type: "checkbox",
      options: null,
    }));
    const emptyTable = makePagedTable(0, () => ({}));

    (supabase.from as any).mockImplementation((tableName: string) => {
      if (tableName === "expense_form_field_templates") return table.chain;
      return emptyTable.chain;
    });

    await fetchFilterableCustomFieldDefinitions("org-1");

    expect(table.chain.range).toHaveBeenCalled();
    expect(table.rangeCalls[0]).toEqual([0, 999]);
  });
});
