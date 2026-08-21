/**
 * DOC-100 pt.2 — Correction/review conditional fields load on demand.
 *
 * OD-1  loadCorrectionCustomFields does NOT query expense_form_field_option_branches
 *       directly anymore (no unbounded `.in("parent_template_id", [...])` scan)
 * OD-2  loadCorrectionCustomFields calls the runtime RPC only for select templates
 *       that have an actual SAVED parent value
 * OD-3  loadCorrectionCustomFields does not call the RPC at all when no select
 *       template has a saved value
 * OD-4  loadCorrectionCustomFields surfaces loadError when the runtime RPC fails,
 *       without throwing
 * OD-5  mergeCorrectionOptionBranches replaces a template's branch subtree
 *       (root + nested descendants) while leaving other templates untouched
 * OD-6  fetchCorrectionOptionBranches (on-demand refetch) returns the fresh
 *       option's branches for a mid-correction parent-value change
 */

import { describe, it, expect, vi } from "vitest";
import {
  loadCorrectionCustomFields,
  mergeCorrectionOptionBranches,
  fetchCorrectionOptionBranches,
} from "@/lib/loadCorrectionCustomFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

function makeBranch(
  id: string,
  parentTemplateId: string,
  parentOptionValue: string,
  parentBranchId: string | null = null,
): OptionBranchDefinition {
  return {
    id,
    organization_id: "org-1",
    parent_template_id: parentTemplateId,
    parent_option_value: parentOptionValue,
    parent_branch_id: parentBranchId,
    field_key: id,
    name: `Branch ${id}`,
    field_type: "text",
    required: false,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: null,
    display_order: 0,
  };
}

function makeSelectAssignment(templateId: string, name: string) {
  return {
    required: null,
    show_on_submit: true,
    expense_form_field_templates: {
      id: templateId,
      name,
      field_type: "select",
      required: false,
      placeholder: null,
      help_text: null,
      validation_rules: null,
      options: ["ABC", "XYZ"],
      show_on_submit: true,
    },
  };
}

/** Supabase mock that also exposes an .rpc() spy, unlike the older fixtures
 *  in this suite which pre-date the RPC-based bounded fetch. */
function mockSupabaseWithRpc(overrides: {
  categories?: unknown[];
  assignments?: unknown[];
  values?: unknown[];
  rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}) {
  const cats = overrides.categories ?? [];
  const assignments = overrides.assignments ?? [];
  const values = overrides.values ?? [];

  const fromTableSpy = vi.fn();

  const makeChain = (data: unknown[], error: unknown = null) => {
    const chain: Record<string, unknown> = {};
    const fn = () => chain;
    chain.select = fn;
    chain.eq = fn;
    chain.ilike = fn;
    chain.in = fn;
    chain.order = fn;
    chain.limit = () => Promise.resolve({ data, error });
    chain.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve({ data, error }).then(resolve);
    return chain;
  };

  const rpcSpy = vi.fn(
    overrides.rpcImpl ?? (() => Promise.resolve({ data: { branches: [] }, error: null })),
  );

  return {
    from: (table: string) => {
      fromTableSpy(table);
      if (table === "expense_categories") return makeChain(cats);
      if (table === "expense_category_form_fields") return makeChain(assignments);
      if (table === "expense_form_field_option_branches") return makeChain([]);
      if (table === "expense_form_field_values") return makeChain(values);
      return makeChain([]);
    },
    rpc: rpcSpy,
    _fromTableSpy: fromTableSpy,
    _rpcSpy: rpcSpy,
  };
}

describe("OD-1 — no direct expense_form_field_option_branches table query", () => {
  it("never calls .from('expense_form_field_option_branches')", async () => {
    const sb = mockSupabaseWithRpc({
      categories: [{ id: "cat-1" }],
      assignments: [makeSelectAssignment("t1", "Type")],
      values: [{ template_id: "t1", branch_field_id: null, field_value: "ABC" }],
      rpcImpl: () =>
        Promise.resolve({
          data: { branches: [{ id: "b1", parent_option_value: "ABC", field_key: "b1", name: "Sub", field_type: "text", required: false }] },
          error: null,
        }),
    });
    await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(sb._fromTableSpy).not.toHaveBeenCalledWith("expense_form_field_option_branches");
  });
});

describe("OD-2 — RPC called only for select templates with a saved parent value", () => {
  it("calls the runtime RPC with the saved (templateId, optionValue) pair", async () => {
    const sb = mockSupabaseWithRpc({
      categories: [{ id: "cat-1" }],
      assignments: [makeSelectAssignment("t1", "Type")],
      values: [{ template_id: "t1", branch_field_id: null, field_value: "ABC" }],
    });
    const model = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(sb._rpcSpy).toHaveBeenCalledTimes(1);
    expect(sb._rpcSpy).toHaveBeenCalledWith(
      "get_runtime_form_option_configuration",
      expect.objectContaining({
        p_organization_id: "org-1",
        p_template_id: "t1",
        p_parent_option_value: "ABC",
      }),
    );
    expect(model.loadError).toBeUndefined();
  });
});

describe("OD-3 — RPC not called when no select template has a saved value", () => {
  it("skips the RPC entirely when the select field's value is unset", async () => {
    const sb = mockSupabaseWithRpc({
      categories: [{ id: "cat-1" }],
      assignments: [makeSelectAssignment("t1", "Type")],
      values: [],
    });
    await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(sb._rpcSpy).not.toHaveBeenCalled();
  });
});

describe("OD-4 — RPC failure surfaces loadError without throwing", () => {
  it("returns a loadError message instead of throwing when the RPC errors", async () => {
    const sb = mockSupabaseWithRpc({
      categories: [{ id: "cat-1" }],
      assignments: [makeSelectAssignment("t1", "Type")],
      values: [{ template_id: "t1", branch_field_id: null, field_value: "ABC" }],
      rpcImpl: () => Promise.resolve({ data: null, error: { message: "network down" } }),
    });
    const model = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(model.loadError).toBeTruthy();
    expect(model.optionBranches).toEqual([]);
  });
});

describe("OD-5 — mergeCorrectionOptionBranches replaces only the changed template's subtree", () => {
  it("drops the old root + nested branches for templateId and keeps other templates untouched", () => {
    const current = [
      makeBranch("root-old", "t1", "ABC"),
      makeBranch("nested-old", "t1", "child-val", "root-old"),
      makeBranch("other-template", "t2", "SomeValue"),
    ];
    const fresh = [makeBranch("root-new", "t1", "XYZ")];
    const merged = mergeCorrectionOptionBranches(current, "t1", fresh);
    const ids = merged.map((b) => b.id).sort();
    expect(ids).toEqual(["other-template", "root-new"].sort());
  });
});

describe("OD-6 — fetchCorrectionOptionBranches loads a new option's branches on demand", () => {
  it("returns the branches for the newly selected value via the runtime RPC", async () => {
    const rpcSpy = vi.fn().mockResolvedValue({
      data: { branches: [{ id: "b-xyz", parent_option_value: "XYZ", field_key: "b-xyz", name: "XYZ field", field_type: "text", required: false }] },
      error: null,
    });
    const client = { rpc: rpcSpy } as any;
    const result = await fetchCorrectionOptionBranches(client, "org-1", "t1", "XYZ");
    expect(result.error).toBe(false);
    expect(result.branches).toHaveLength(1);
    expect(result.branches[0].parent_option_value).toBe("XYZ");
  });
});
