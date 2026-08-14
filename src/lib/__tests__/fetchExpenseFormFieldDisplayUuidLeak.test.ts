/**
 * Regression tests for the "Additional Information" UUID-leak/duplication bug
 * (2026-08-13, MicroLink Production screenshot): a field's proper label
 * ("Project Unique ID: 202412M767") rendered correctly, then the SAME value
 * rendered again directly underneath keyed by the internal field UUID
 * ("51181324-...: 202412M767").
 *
 * Root cause: get_debug_review_expense_detail_v1 falls back a field's
 * `field_key` to its raw `id::text` when no name/field_key is configured;
 * ReviewExpenseDetail.tsx used that as a prefetchedFields map key, and
 * fetchExpenseFormFieldDisplay's rowsFromPrefetchedFields()/
 * buildFieldMapFromLoadedData() used ANY map key directly as a display label
 * with no validation, plus mergeDisplayRows() dropped stableId on merge so
 * the duplicate couldn't be caught by identity-based dedup either.
 *
 * These tests exercise the shared formatter directly (fetchExpenseFormFieldDisplay.ts)
 * so the fix is proven at the layer that owns it, independent of any one caller.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchExpenseFormFieldDisplay,
  isUuidLikeLabel,
} from "@/lib/fetchExpenseFormFieldDisplay";

const REAL_UUID_1 = "51181324-68cc-4174-bbe0-4834e5e22c48";
const REAL_UUID_2 = "5308e883-78a4-4bee-abed-67f4e0e5fee8";
const REAL_UUID_3 = "ca80b2f7-0199-4f9a-b425-230e84aecd12";

const VALUE_ROWS = [
  { id: "v1", template_id: "tpl-1", branch_field_id: null, field_value: "202412M767" },
  { id: "v2", template_id: null, branch_field_id: "br-1", field_value: "Room" },
  { id: "v3", template_id: null, branch_field_id: "br-2", field_value: "Ril2" },
];
const TEMPLATE_ROWS = [{ id: "tpl-1", name: "Project Unique ID", field_key: null }];
const BRANCH_ROWS = [
  { id: "br-1", name: "From location", field_key: null, display_order: 1, parent_template_id: null, parent_branch_id: null },
  { id: "br-2", name: "To location", field_key: null, display_order: 2, parent_template_id: null, parent_branch_id: null },
];

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

function chainResolvingTo(data: unknown) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
  return chain;
}

function makeSupabase() {
  return {
    from(table: string) {
      if (table === "expenses") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { organization_id: "org-1" }, error: null }) }) }) }) };
      }
      if (table === "expense_form_field_values") return chainResolvingTo(VALUE_ROWS);
      if (table === "expense_form_field_templates") return chainResolvingTo(TEMPLATE_ROWS);
      if (table === "expense_form_field_option_branches") return chainResolvingTo(BRANCH_ROWS);
      if (table === "expense_category_form_fields") return chainResolvingTo([]);
      return chainResolvingTo([]);
    },
    rpc: () => Promise.resolve({ data: [], error: { message: "function not found" } }),
  };
}

describe("isUuidLikeLabel", () => {
  it("recognizes raw UUIDs", () => {
    expect(isUuidLikeLabel(REAL_UUID_1)).toBe(true);
    expect(isUuidLikeLabel("  " + REAL_UUID_2 + "  ")).toBe(true);
  });

  it("does not flag ordinary field labels", () => {
    expect(isUuidLikeLabel("Project Unique ID")).toBe(false);
    expect(isUuidLikeLabel("From location")).toBe(false);
    expect(isUuidLikeLabel("")).toBe(false);
  });
});

describe("fetchExpenseFormFieldDisplay — UUID-keyed prefetch never becomes a visible label", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("drops UUID-keyed prefetched fields instead of rendering them as labels", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof fetchExpenseFormFieldDisplay>[0];
    const result = await fetchExpenseFormFieldDisplay(supabase, "exp-1", "org-1", "review", {
      prefetchedFields: {
        [REAL_UUID_1]: "202412M767",
        [REAL_UUID_2]: "Room",
        [REAL_UUID_3]: "Ril2",
      },
    });

    const labels = result.map((r) => r.name);
    expect(labels).not.toContain(REAL_UUID_1);
    expect(labels).not.toContain(REAL_UUID_2);
    expect(labels).not.toContain(REAL_UUID_3);
  });

  it("renders exactly one row per logical field — no duplicate for the same value", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof fetchExpenseFormFieldDisplay>[0];
    const result = await fetchExpenseFormFieldDisplay(supabase, "exp-1", "org-1", "review", {
      prefetchedFields: {
        [REAL_UUID_1]: "202412M767",
        [REAL_UUID_2]: "Room",
        [REAL_UUID_3]: "Ril2",
      },
    });

    const values = result.map((r) => r.field_value).sort();
    expect(values).toEqual(["202412M767", "Ril2", "Room"].sort());
    // Exactly 3 fields — the UUID-keyed prefetch entries did not add 3 more.
    expect(result).toHaveLength(3);
  });

  it("shows the correct human labels for all three fields", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof fetchExpenseFormFieldDisplay>[0];
    const result = await fetchExpenseFormFieldDisplay(supabase, "exp-1", "org-1", "review", {
      prefetchedFields: {
        [REAL_UUID_1]: "202412M767",
        [REAL_UUID_2]: "Room",
        [REAL_UUID_3]: "Ril2",
      },
    });

    const byLabel = new Map(result.map((r) => [r.name, r.field_value]));
    expect(byLabel.get("Project Unique ID")).toBe("202412M767");
    expect(byLabel.get("From location")).toBe("Room");
    expect(byLabel.get("To location")).toBe("Ril2");
  });

  it("a legitimately UUID-shaped field VALUE (not a label) is preserved untouched", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof fetchExpenseFormFieldDisplay>[0];
    const result = await fetchExpenseFormFieldDisplay(supabase, "exp-1", "org-1", "review", {
      prefetchedFields: { "Reference Code": REAL_UUID_1 },
    });
    const byLabel = new Map(result.map((r) => [r.name, r.field_value]));
    expect(byLabel.get("Reference Code")).toBe(REAL_UUID_1);
  });

  it("works with no prefetched fields at all (unaffected baseline)", async () => {
    const supabase = makeSupabase() as unknown as Parameters<typeof fetchExpenseFormFieldDisplay>[0];
    const result = await fetchExpenseFormFieldDisplay(supabase, "exp-1", "org-1", "review");
    expect(result).toHaveLength(3);
    expect(result.every((r) => !isUuidLikeLabel(r.name))).toBe(true);
  });
});
