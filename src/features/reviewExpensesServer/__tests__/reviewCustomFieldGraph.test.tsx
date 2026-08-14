/**
 * Conditional custom-field filters + the 20260802010000 contract (DOC-080).
 *
 * The screenshot that triggered this showed one "Project Unique ID" and roughly
 * a dozen identical "Project ID" dropdowns, because every branch definition was
 * rendered as its own control. These tests pin the tree behaviour that replaces
 * it, plus the KPI and anchor contract changes in the same migration.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { ReactNode } from "react";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) => {
      if (!params) return k;
      const vals = Object.entries(params)
        .filter(([p]) => p !== "defaultValue")
        .map(([, v]) => String(v))
        .join(" ");
      return vals ? `${k} ${vals}` : k;
    },
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children?: ReactNode }) => children ?? null,
}));

import {
  applySelection,
  customFieldKey,
  customFiltersToValues,
  descendantKeys,
  fieldCounts,
  pruneHidden,
  valuesToCustomFilters,
  visibleFields,
} from "@/features/reviewExpensesServer/customFieldGraph";
import { ReviewCustomFieldFilters } from "@/features/reviewExpensesServer/ReviewCustomFieldFilters";
import type { ReviewFilterField } from "@/features/reviewQueueServer/types";

const cwd = process.cwd();
const strip = (s: string) =>
  s.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
const SQL = strip(
  readFileSync(
    resolve(cwd, "supabase/migrations/20260802010000_review_queue_scope_filters_and_anchor.sql"),
    "utf-8",
  ),
);

// ── The shape that produced the bug ────────────────────────────────────────
// One root "Project Name" template, three of its values each revealing a
// "Project Unique ID" branch, and each of THOSE revealing a "Project ID" branch.
// Flat rendering shows 1 + 3 + 6 = 10 controls; the tree shows 1.

const field = (o: Partial<ReviewFilterField> & { field_id: string }): ReviewFilterField =>
  ({
    source: "branch",
    field_key: o.field_id,
    label: o.field_id,
    options: ["x", "y"],
    parent_template_id: null,
    parent_branch_id: null,
    parent_option_value: null,
    display_order: 0,
    depth: 1,
    is_root: false,
    ...o,
  }) as ReviewFilterField;

const T_NAME = "t-project-name";
const FIELDS: ReviewFilterField[] = [
  field({
    source: "template",
    field_id: T_NAME,
    label: "Project Name",
    options: ["Alpha", "Beta", "Gamma"],
    depth: 0,
    is_root: true,
  }),
  // One "Project Unique ID" per parent value.
  ...["Alpha", "Beta", "Gamma"].map((v, i) =>
    field({
      field_id: `b-uid-${i}`,
      label: "Project Unique ID",
      parent_template_id: T_NAME,
      parent_option_value: v,
      options: [`${v}-1`, `${v}-2`],
      depth: 1,
    }),
  ),
  // Two "Project ID" per unique-id value — six identical labels in total.
  ...["Alpha", "Beta", "Gamma"].flatMap((v, i) =>
    [1, 2].map((n) =>
      field({
        field_id: `b-pid-${i}-${n}`,
        label: "Project ID",
        parent_branch_id: `b-uid-${i}`,
        parent_option_value: `${v}-${n}`,
        options: [`PID-${v}-${n}`],
        depth: 2,
      }),
    ),
  ),
];

const key = (id: string, source = "branch") => customFieldKey(source, id);

describe("custom-field tree", () => {
  it("shows only root fields before anything is selected", () => {
    const shown = visibleFields(FIELDS, {});
    expect(shown).toHaveLength(1);
    expect(shown[0].field_id).toBe(T_NAME);
  });

  it("does NOT render a dropdown per branch definition", () => {
    const counts = fieldCounts(FIELDS, {});
    expect(counts.templates).toBe(1);
    expect(counts.branches).toBe(9);
    // Flat rendering would have shown all ten.
    expect(counts.visible).toBe(1);
  });

  it("reveals exactly one Project Unique ID for the selected parent value", () => {
    const shown = visibleFields(FIELDS, { [key(T_NAME, "template")]: "Beta" });
    const uids = shown.filter((f) => f.label === "Project Unique ID");
    expect(uids).toHaveLength(1);
    expect(uids[0].field_id).toBe("b-uid-1");
    // The other two parents are not selected, so their children stay hidden.
    expect(shown.filter((f) => f.label === "Project ID")).toHaveLength(0);
  });

  it("reveals exactly one Project ID after the grandparent chain is chosen", () => {
    const values = {
      [key(T_NAME, "template")]: "Beta",
      [key("b-uid-1")]: "Beta-2",
    };
    const shown = visibleFields(FIELDS, values);
    const pids = shown.filter((f) => f.label === "Project ID");
    expect(pids).toHaveLength(1);
    expect(pids[0].field_id).toBe("b-pid-1-2");
    expect(shown).toHaveLength(3); // name -> unique id -> id
  });

  it("never shows two branches that share a label but sit under different parents", () => {
    // A single-select parent can only hold one value, so only one path is live.
    for (const v of ["Alpha", "Beta", "Gamma"]) {
      const shown = visibleFields(FIELDS, { [key(T_NAME, "template")]: v });
      expect(shown.filter((f) => f.label === "Project Unique ID")).toHaveLength(1);
    }
  });

  it("clears descendants when a parent value changes", () => {
    const before = {
      [key(T_NAME, "template")]: "Beta",
      [key("b-uid-1")]: "Beta-2",
      [key("b-pid-1-2")]: "PID-Beta-2",
    };
    const after = applySelection(FIELDS, before, key(T_NAME, "template"), "Gamma");
    expect(after[key(T_NAME, "template")]).toBe("Gamma");
    expect(after[key("b-uid-1")]).toBeUndefined();
    expect(after[key("b-pid-1-2")]).toBeUndefined();
  });

  it("clears every descendant when a parent is cleared", () => {
    const before = {
      [key(T_NAME, "template")]: "Beta",
      [key("b-uid-1")]: "Beta-2",
      [key("b-pid-1-2")]: "PID-Beta-2",
    };
    const after = applySelection(FIELDS, before, key(T_NAME, "template"), "");
    expect(Object.keys(after)).toHaveLength(0);
    expect(visibleFields(FIELDS, after)).toHaveLength(1);
  });

  it("prunes hidden values so they cannot reach p_custom_filters", () => {
    // A stale descendant would silently narrow results with no visible control.
    const stale = { [key("b-pid-2-1")]: "PID-Gamma-1" };
    expect(pruneHidden(FIELDS, stale)).toEqual({});
    expect(valuesToCustomFilters(pruneHidden(FIELDS, stale))).toEqual([]);
  });

  it("lists every descendant of a field", () => {
    const root = FIELDS.find((f) => f.field_id === T_NAME)!;
    expect(descendantKeys(FIELDS, root)).toHaveLength(9);
  });

  it("survives cyclic metadata instead of recursing forever", () => {
    const cyclic: ReviewFilterField[] = [
      field({ source: "template", field_id: "t1", options: ["a"], depth: 0, is_root: true }),
      field({ field_id: "c1", parent_template_id: "t1", parent_option_value: "a", options: ["b"] }),
      field({ field_id: "c2", parent_branch_id: "c1", parent_option_value: "b", options: ["a"] }),
      // c1 declared as its own grandchild.
      field({ field_id: "c1", parent_branch_id: "c2", parent_option_value: "a", options: ["b"] }),
    ];
    const shown = visibleFields(cyclic, {
      [key("t1", "template")]: "a",
      [key("c1")]: "b",
      [key("c2")]: "a",
    });
    expect(shown.length).toBeLessThanOrEqual(4);
  });

  it("keeps stable template and branch identities", () => {
    expect(customFieldKey("template", "abc")).toBe("template:abc");
    expect(customFieldKey("branch", "def")).toBe("branch:def");
    const filters = valuesToCustomFilters({ "template:abc": "X", "branch:def": "Y" });
    expect(filters).toEqual([
      { source: "template", field_id: "abc", values: ["X"] },
      { source: "branch", field_id: "def", values: ["Y"] },
    ]);
    expect(valuesToCustomFilters(customFiltersToValues(filters))).toEqual(filters);
  });
});

describe("custom-field filter UI", () => {
  const options = { custom_fields: FIELDS } as never;

  const renderFilters = (customFilters: unknown[] = []) => {
    const onChange = vi.fn();
    render(
      <ReviewCustomFieldFilters
        options={options}
        customFilters={customFilters as never}
        onChange={onChange}
      />,
    );
    return { onChange };
  };

  it("renders one control before any selection, not a dozen", () => {
    renderFilters();
    expect(document.querySelectorAll('[data-testid^="review-custom-field-"]')).toHaveLength(1);
    expect(screen.getByTestId(`review-custom-field-template:${T_NAME}`)).toBeTruthy();
  });

  it("shows Project Unique ID once and no Project ID after a parent is chosen", () => {
    renderFilters([{ source: "template", field_id: T_NAME, values: ["Beta"] }]);
    const cells = document.querySelectorAll('[data-testid^="review-custom-field-"]');
    expect(cells).toHaveLength(2);
    expect(screen.getByTestId("review-custom-field-branch:b-uid-1")).toBeTruthy();
    expect(screen.queryByTestId("review-custom-field-branch:b-pid-1-1")).toBeNull();
  });

  it("shows exactly one Project ID once the chain is complete", () => {
    renderFilters([
      { source: "template", field_id: T_NAME, values: ["Beta"] },
      { source: "branch", field_id: "b-uid-1", values: ["Beta-2"] },
    ]);
    expect(document.querySelectorAll('[data-testid^="review-custom-field-"]')).toHaveLength(3);
    expect(screen.getByTestId("review-custom-field-branch:b-pid-1-2")).toBeTruthy();
    expect(screen.queryByTestId("review-custom-field-branch:b-pid-1-1")).toBeNull();
  });

  it("uses a responsive grid that closes the gap when a child disappears", () => {
    renderFilters();
    const grid = screen.getByTestId("review-custom-fields").querySelector("div.grid");
    expect(grid?.className).toContain("grid-cols-1");
    expect(grid?.className).toContain("sm:grid-cols-2");
    expect(grid?.className).toContain("lg:grid-cols-4");
  });

  it("renders nothing at all when the org has no filterable fields", () => {
    render(
      <ReviewCustomFieldFilters options={{ custom_fields: [] } as never} customFilters={[]} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId("review-custom-fields")).toBeNull();
  });

  it("never queries expense_form_field_values from the browser", () => {
    const src = [
      "src/features/reviewExpensesServer/ReviewCustomFieldFilters.tsx",
      "src/features/reviewExpensesServer/customFieldGraph.ts",
    ]
      // Executable code only — the doc comments legitimately name the table
      // when explaining why the browser must not read it.
      .map((f) =>
        readFileSync(resolve(cwd, f), "utf-8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1"),
      )
      .join("\n");
    expect(src).not.toContain("expense_form_field_values");
    expect(src).not.toMatch(/supabase/);
  });
});

// ── The 20260802010000 migration ───────────────────────────────────────────

describe("migration 20260802010000", () => {
  it("is additive — no table DDL and no drops", () => {
    expect(SQL).not.toMatch(/DROP\s+(FUNCTION|TABLE|COLUMN)/i);
    expect(SQL).not.toMatch(/ALTER\s+TABLE/i);
    expect(SQL).not.toMatch(/CREATE\s+TEMP\s+TABLE/i);
  });

  it("makes assigned_to_me the complete visible scope", () => {
    expect(SQL).toContain("count(*) AS assigned_to_me");
    expect(SQL).toContain("count(*) AS scope_total");
  });

  it("preserves the direct-assignment count separately", () => {
    expect(SQL).toContain("directly_assigned");
    expect(SQL).toMatch(
      /count\(\*\) FILTER \(WHERE s\.assigned_reviewer_id = auth\.uid\(\)[\s\S]{0,80}directly_assigned/,
    );
  });

  it("returns the branch tree metadata the client needs", () => {
    for (const k of [
      "'parent_template_id', b.parent_template_id",
      "'parent_branch_id', b.parent_branch_id",
      "'parent_option_value', b.parent_option_value",
      "'display_order', coalesce(b.display_order, 0)",
      "'is_root', false",
    ]) {
      expect(SQL).toContain(k);
    }
    expect(SQL).toContain("'is_root', true");
  });

  it("computes branch depth with a cycle-safe recursive CTE", () => {
    expect(SQL).toContain("WITH RECURSIVE");
    expect(SQL).toContain("branch_depth");
    expect(SQL).toContain("bd.path || c.id");
    expect(SQL).toContain("NOT c.id = ANY(bd.path)");
    expect(SQL).toContain("bd.depth < 10");
  });

  it("excludes retired and unused branch definitions", () => {
    expect(SQL).toContain("b.retired_at IS NULL");
    expect(SQL).toContain("used_branches");
  });

  it("shares one keyed relation between the page and the anchor", () => {
    const calls = SQL.match(/public\._debug_review_keyed_scope_v1\(/g) ?? [];
    // Defined once, called by the page once and by the anchor twice.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(
      (SQL.match(/CREATE OR REPLACE FUNCTION public\._debug_review_keyed_scope_v1/g) ?? []).length,
    ).toBe(1);
  });

  it("keeps the ordinary page RPC free of any positional scan", () => {
    const pageFn = SQL.slice(
      SQL.indexOf("FUNCTION public.get_debug_review_queue_page_v1"),
      SQL.indexOf("FUNCTION public.get_debug_review_queue_page_anchor_v1"),
    );
    expect(pageFn).not.toMatch(/\bOFFSET\b/i);
    expect(pageFn).toContain("(k.sk, k.expense_id) > (v_c_sk, v_c_id)");
  });

  it("validates the anchor target page", () => {
    const anchor = SQL.slice(SQL.indexOf("FUNCTION public.get_debug_review_queue_page_anchor_v1"));
    expect(anchor).toContain("target page must be 1 or greater");
    expect(anchor).toContain("exceeds");
    expect(anchor).toContain("22023");
    // Page 1 starts at the beginning, so no cursor is resolved for it.
    expect(anchor).toContain("IF p_target_page > 1 THEN");
    expect(anchor).toContain("a.rn = (p_target_page - 1)::bigint * v_size");
  });

  it("requires the anchor before reporting ready", () => {
    expect(SQL).toContain("AND f.page_anchor AND f.keyed_scope");
    expect(SQL).toContain("'page_anchor', f.page_anchor");
    expect(SQL).toContain("'schema_revision', '20260802010000'");
  });

  it("keeps every new function locked down", () => {
    const defs = SQL.match(/CREATE OR REPLACE FUNCTION public\.\w+/g) ?? [];
    expect((SQL.match(/SECURITY DEFINER/g) ?? []).length).toBe(defs.length);
    expect((SQL.match(/SET search_path = ''/g) ?? []).length).toBe(defs.length);
    expect((SQL.match(/REVOKE ALL ON FUNCTION[^;]*FROM anon/g) ?? []).length).toBe(defs.length);
    expect(SQL).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*TO (anon|PUBLIC)/);
  });
});
