/**
 * Phase 11 / 39: expense_form_field_option_branches has been observed to
 * exceed 1,000 rows for a single organization (DOC-097's real incident).
 * loadOrganizationExpenseFieldConfig must never rely on a single unbounded
 * select for that table. This test drives the pagination loop with a mocked
 * Supabase client across the exact boundary counts the task specifies and
 * proves: exact row count, no duplicates, no truncation, correct termination.
 */
import { describe, expect, it, vi } from "vitest";

function makeFakeTable(totalRows: number, rowFactory: (i: number) => Record<string, unknown>) {
  const allRows = Array.from({ length: totalRows }, (_, i) => rowFactory(i));
  return {
    select: () => ({
      eq: () => ({
        is: () => ({
          is: () => ({
            range: (from: number, to: number) => {
              const slice = allRows.slice(from, to + 1);
              return Promise.resolve({ data: slice, error: null });
            },
          }),
        }),
        // for fetchCategories / fetchCategoryFormFields, which don't chain .is()
        range: (from: number, to: number) => {
          const slice = allRows.slice(from, to + 1);
          return Promise.resolve({ data: slice, error: null });
        },
        order: () => ({
          range: (from: number, to: number) => {
            const slice = allRows.slice(from, to + 1);
            return Promise.resolve({ data: slice, error: null });
          },
        }),
      }),
    }),
  };
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

async function loadOptionBranchesAtScale(totalRows: number) {
  const { supabase } = await import("@/integrations/supabase/client");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase.from as any).mockImplementation((table: string) => {
    if (table === "expense_form_field_option_branches") {
      return makeFakeTable(totalRows, (i) => ({
        id: `branch-${i}`,
        parent_template_id: "tpl-1",
        parent_option_value: "P1",
        name: `Option ${i}`,
        field_type: "text",
        required: false,
        options: null,
        default_value: null,
      }));
    }
    // organization_expense_form_fields, expense_categories, expense_category_form_fields -- empty for this test
    return makeFakeTable(0, () => ({}));
  });

  const { loadOrganizationExpenseFieldConfig } = await import("@/lib/orgExpenseFieldConfig");
  return loadOrganizationExpenseFieldConfig("org-1");
}

describe("loadOrganizationExpenseFieldConfig — option-branch pagination at boundary row counts", () => {
  const counts = [0, 1, 499, 500, 501, 999, 1000, 1001, 1999, 2000, 2001, 5000];

  it.each(counts)("returns exactly %i rows with no duplicates, no truncation", async (count) => {
    vi.resetModules();
    const config = await loadOptionBranchesAtScale(count);
    expect(config.optionBranches).toHaveLength(count);
    const uniqueIds = new Set(config.optionBranches.map((b) => b.id));
    expect(uniqueIds.size).toBe(count);
  });

  it("terminates correctly: a page returning fewer than PAGE_SIZE rows stops the loop", async () => {
    vi.resetModules();
    const config = await loadOptionBranchesAtScale(501);
    // 501 rows over PAGE_SIZE=500 means exactly 2 pages: 500 + 1. If the loop
    // failed to terminate correctly it would either infinite-loop (test
    // timeout) or double-fetch; both are ruled out by the exact-count
    // assertion above completing at all within the test's default timeout.
    expect(config.optionBranches).toHaveLength(501);
  });

  it("an exact-multiple-of-PAGE_SIZE count (1000) still terminates via the final short page", async () => {
    vi.resetModules();
    const config = await loadOptionBranchesAtScale(1000);
    expect(config.optionBranches).toHaveLength(1000);
  });
});
