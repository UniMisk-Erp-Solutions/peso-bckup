/**
 * DOC-046 — Singular Expense Correction Data Safety
 *
 * SCS-1   buildCorrectionCustomFieldPatch — no changes → returns []
 * SCS-2   buildCorrectionCustomFieldPatch — template field value changed → set item
 * SCS-3   buildCorrectionCustomFieldPatch — template field cleared (had value, now empty) → clear item
 * SCS-4   buildCorrectionCustomFieldPatch — template field newly set (initial null, now value) → set item
 * SCS-5   buildCorrectionCustomFieldPatch — unloaded template ID excluded (not in categoryFormFields)
 * SCS-6   buildCorrectionCustomFieldPatch — invisible branch with existing value → clear item
 * SCS-7   buildCorrectionCustomFieldPatch — invisible branch with no stored value → excluded
 * SCS-8   buildCorrectionCustomFieldPatch — visible branch changed → set item
 * SCS-9   buildCorrectionCustomFieldPatch — visible branch cleared → clear item
 * SCS-10  buildCorrectionCustomFieldPatch — checkbox "false" default, unchanged → no item
 * SCS-11  buildCorrectionCustomFieldPatch — checkbox changed to "true" → set item
 * SCS-12  buildCorrectionCustomFieldPatch — whitespace-only treated as empty (normalised)
 * SCS-13  buildCorrectionCustomFieldPatch — multiple mixed changes → correct item list
 * SCS-14  loadCorrectionCustomFields — returns EMPTY when organizationId is missing
 * SCS-15  loadCorrectionCustomFields — returns EMPTY when categoryName is missing
 * SCS-16  loadCorrectionCustomFields — returns loadError when category not found
 * SCS-17  loadCorrectionCustomFields — returns loadError when category is ambiguous
 * SCS-18  loadCorrectionCustomFields — does NOT filter by show_on_submit
 * SCS-19  loadCorrectionCustomFields — initialFormFieldValues matches formFieldValues at load time
 * SCS-20  loadCorrectionCustomFields — initialBranchValues matches branchValues at load time
 */

import { describe, it, expect, vi, type Mock } from "vitest";
import {
  buildCorrectionCustomFieldPatch,
  type PatchItem,
} from "@/lib/buildCorrectionCustomFieldPatch";
import {
  loadCorrectionCustomFields,
  EMPTY_CORRECTION_FIELDS,
  type CorrectionCustomFieldsModel,
} from "@/lib/loadCorrectionCustomFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeModel(
  opts: Partial<
    Pick<
      CorrectionCustomFieldsModel,
      | "categoryFormFields"
      | "optionBranches"
      | "initialFormFieldValues"
      | "initialBranchValues"
      | "formFieldValues"
      | "branchValues"
    >
  >,
): Pick<
  CorrectionCustomFieldsModel,
  | "categoryFormFields"
  | "optionBranches"
  | "initialFormFieldValues"
  | "initialBranchValues"
  | "formFieldValues"
  | "branchValues"
> {
  return {
    categoryFormFields: opts.categoryFormFields ?? [],
    optionBranches: opts.optionBranches ?? [],
    initialFormFieldValues: opts.initialFormFieldValues ?? {},
    initialBranchValues: opts.initialBranchValues ?? {},
    formFieldValues: opts.formFieldValues ?? {},
    branchValues: opts.branchValues ?? {},
  };
}

function makeField(id: string, fieldType = "text") {
  return {
    template: {
      id,
      name: `Field ${id}`,
      field_type: fieldType,
      required: false,
      placeholder: null,
      help_text: null,
      validation_rules: null,
      options: null,
    },
    required: null,
  };
}

function makeBranch(id: string, parentTemplateId: string, parentOptionValue: string): OptionBranchDefinition {
  return {
    id,
    organization_id: "org-1",
    parent_template_id: parentTemplateId,
    parent_option_value: parentOptionValue,
    parent_branch_id: null,
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

/** Minimal supabase chain mock for loadCorrectionCustomFields tests. */
function mockSupabase(overrides: {
  categories?: unknown[];
  assignments?: unknown[];
  branches?: unknown[];
  values?: unknown[];
}) {
  const cats = overrides.categories ?? [];
  const assignments = overrides.assignments ?? [];
  const branches = overrides.branches ?? [];
  const values = overrides.values ?? [];

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

  return {
    from: (table: string) => {
      if (table === "expense_categories") return makeChain(cats);
      if (table === "expense_category_form_fields") return makeChain(assignments);
      if (table === "expense_form_field_option_branches") return makeChain(branches);
      if (table === "expense_form_field_values") return makeChain(values);
      return makeChain([]);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SCS-1 to SCS-13: buildCorrectionCustomFieldPatch
// ═════════════════════════════════════════════════════════════════════════════

describe("SCS-1 — no changes → returns []", () => {
  it("emits no items when initial and current values are identical", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1")],
      initialFormFieldValues: { t1: "Alpha" },
      formFieldValues: { t1: "Alpha" },
    });
    expect(buildCorrectionCustomFieldPatch(model, new Set())).toEqual([]);
  });
});

describe("SCS-2 — template field value changed → set item", () => {
  it("emits a set item when a template field value changes", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1")],
      initialFormFieldValues: { t1: "Alpha" },
      formFieldValues: { t1: "Beta" },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject<Partial<PatchItem>>({
      template_id: "t1",
      branch_field_id: null,
      operation: "set",
      old_value: "Alpha",
      new_value: "Beta",
    });
  });
});

describe("SCS-3 — template field cleared → clear item", () => {
  it("emits a clear item when a template field goes from value to empty", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1")],
      initialFormFieldValues: { t1: "Alpha" },
      formFieldValues: { t1: "" },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject<Partial<PatchItem>>({
      template_id: "t1",
      operation: "clear",
      old_value: "Alpha",
      new_value: null,
    });
  });
});

describe("SCS-4 — template field newly set (initial null, current value) → set item", () => {
  it("emits a set item when a field is set for the first time", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1")],
      initialFormFieldValues: {},
      formFieldValues: { t1: "New Value" },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject<Partial<PatchItem>>({
      template_id: "t1",
      operation: "set",
      old_value: null,
      new_value: "New Value",
    });
  });
});

describe("SCS-5 — unloaded template ID excluded from patch", () => {
  it("does not emit items for template IDs not in categoryFormFields", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1")],
      initialFormFieldValues: { t1: "Alpha", t_extra: "OldVal" },
      formFieldValues: { t1: "Alpha", t_extra: "Changed" },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch.find((p) => p.template_id === "t_extra")).toBeUndefined();
  });
});

describe("SCS-6 — invisible branch with existing value → clear item", () => {
  it("emits a clear item when a branch field becomes invisible but had a stored value", () => {
    const branch = makeBranch("b1", "t1", "Alpha");
    const model = makeModel({
      optionBranches: [branch],
      initialBranchValues: { b1: "stored" },
      branchValues: { b1: "stored" },
    });
    // b1 is NOT in visibleBranchIds
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject<Partial<PatchItem>>({
      branch_field_id: "b1",
      operation: "clear",
      old_value: "stored",
      new_value: null,
    });
  });
});

describe("SCS-7 — invisible branch with no stored value → excluded", () => {
  it("emits no item for an invisible branch that had no initial value", () => {
    const branch = makeBranch("b1", "t1", "Alpha");
    const model = makeModel({
      optionBranches: [branch],
      initialBranchValues: {},
      branchValues: {},
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch).toHaveLength(0);
  });
});

describe("SCS-8 — visible branch changed → set item", () => {
  it("emits a set item when a visible branch field value changes", () => {
    const branch = makeBranch("b1", "t1", "Alpha");
    const model = makeModel({
      optionBranches: [branch],
      initialBranchValues: { b1: "old" },
      branchValues: { b1: "new" },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set(["b1"]));
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject<Partial<PatchItem>>({
      template_id: null,
      branch_field_id: "b1",
      operation: "set",
      old_value: "old",
      new_value: "new",
    });
  });
});

describe("SCS-9 — visible branch cleared → clear item", () => {
  it("emits a clear item when a visible branch field is cleared", () => {
    const branch = makeBranch("b1", "t1", "Alpha");
    const model = makeModel({
      optionBranches: [branch],
      initialBranchValues: { b1: "stored" },
      branchValues: {},
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set(["b1"]));
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject<Partial<PatchItem>>({
      branch_field_id: "b1",
      operation: "clear",
      old_value: "stored",
    });
  });
});

describe("SCS-10 — checkbox 'false' default, unchanged → no item", () => {
  it("does not emit an item when checkbox stays at default 'false'", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1", "checkbox")],
      initialFormFieldValues: { t1: "false" },
      formFieldValues: { t1: "false" },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch).toHaveLength(0);
  });
});

describe("SCS-11 — checkbox changed to 'true' → set item", () => {
  it("emits a set item when a checkbox changes from false to true", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1", "checkbox")],
      initialFormFieldValues: { t1: "false" },
      formFieldValues: { t1: "true" },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject<Partial<PatchItem>>({
      operation: "set",
      old_value: "false",
      new_value: "true",
    });
  });
});

describe("SCS-12 — whitespace-only treated as empty", () => {
  it("normalises whitespace-only strings to null and treats them as empty", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1"), makeField("t2")],
      initialFormFieldValues: { t1: "  Alpha  ", t2: "  " },
      formFieldValues: { t1: "Alpha", t2: "  " },
    });
    const patch = buildCorrectionCustomFieldPatch(model, new Set());
    // t1 trims to same → no change; t2 was whitespace (null) and still whitespace (null) → no change
    expect(patch).toHaveLength(0);
  });
});

describe("SCS-13 — multiple mixed changes → correct item list", () => {
  it("produces one item per changed field across templates and branches", () => {
    const model = makeModel({
      categoryFormFields: [makeField("t1"), makeField("t2")],
      optionBranches: [makeBranch("b1", "t1", "Alpha"), makeBranch("b2", "t1", "Alpha")],
      initialFormFieldValues: { t1: "Alpha", t2: "Old" },
      initialBranchValues: { b1: "BranchOld", b2: "InvisibleVal" },
      formFieldValues: { t1: "Alpha", t2: "New" },
      branchValues: { b1: "BranchNew", b2: "InvisibleVal" },
    });
    // b1 visible, b2 invisible
    const patch = buildCorrectionCustomFieldPatch(model, new Set(["b1"]));
    expect(patch).toHaveLength(3); // t2 changed, b1 changed, b2 cleared
    expect(patch.find((p) => p.template_id === "t2")?.operation).toBe("set");
    expect(patch.find((p) => p.branch_field_id === "b1")?.operation).toBe("set");
    expect(patch.find((p) => p.branch_field_id === "b2")?.operation).toBe("clear");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SCS-14 to SCS-20: loadCorrectionCustomFields
// ═════════════════════════════════════════════════════════════════════════════

describe("SCS-14 — returns EMPTY when organizationId is missing", () => {
  it("short-circuits and returns EMPTY_CORRECTION_FIELDS with no DB call", async () => {
    const sb = { from: vi.fn() };
    const result = await loadCorrectionCustomFields(sb as any, "", "exp-1", "Travel");
    expect(result.categoryFormFields).toHaveLength(0);
    expect(sb.from).not.toHaveBeenCalled();
  });
});

describe("SCS-15 — returns EMPTY when categoryName is missing", () => {
  it("short-circuits and returns EMPTY_CORRECTION_FIELDS with no DB call", async () => {
    const sb = { from: vi.fn() };
    const result = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "");
    expect(result.categoryFormFields).toHaveLength(0);
    expect(sb.from).not.toHaveBeenCalled();
  });
});

describe("SCS-16 — returns loadError when category not found", () => {
  it("sets loadError and returns empty fields when category lookup returns no rows", async () => {
    const sb = mockSupabase({ categories: [] });
    const result = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(result.categoryFormFields).toHaveLength(0);
    expect(result.loadError).toBeTruthy();
    expect(result.loadError).toContain("Travel");
  });
});

describe("SCS-17 — returns loadError when category is ambiguous", () => {
  it("sets loadError and returns empty fields when 2+ categories match", async () => {
    const sb = mockSupabase({ categories: [{ id: "cat-1" }, { id: "cat-2" }] });
    const result = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(result.categoryFormFields).toHaveLength(0);
    expect(result.loadError).toBeTruthy();
    expect(result.loadError).toContain("Travel");
  });
});

describe("SCS-18 — does NOT filter by show_on_submit", () => {
  it("includes fields where show_on_submit is false", async () => {
    const assignment = {
      required: null,
      show_on_submit: false,
      expense_form_field_templates: {
        id: "t1",
        name: "Hidden Field",
        field_type: "text",
        required: false,
        placeholder: null,
        help_text: null,
        validation_rules: null,
        options: null,
        show_on_submit: false,
      },
    };
    const sb = mockSupabase({
      categories: [{ id: "cat-1" }],
      assignments: [assignment],
    });
    const result = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    // The field must be present even though show_on_submit = false
    expect(result.categoryFormFields).toHaveLength(1);
    expect(result.categoryFormFields[0].template.id).toBe("t1");
  });
});

describe("SCS-19 — initialFormFieldValues matches formFieldValues at load time", () => {
  it("sets initialFormFieldValues to a copy of formFieldValues from saved data", async () => {
    const assignment = {
      required: null,
      show_on_submit: true,
      expense_form_field_templates: {
        id: "t1",
        name: "Project",
        field_type: "text",
        required: false,
        placeholder: null,
        help_text: null,
        validation_rules: null,
        options: null,
        show_on_submit: true,
      },
    };
    const savedValue = { template_id: "t1", branch_field_id: null, field_value: "ProjectA" };
    const sb = mockSupabase({
      categories: [{ id: "cat-1" }],
      assignments: [assignment],
      values: [savedValue],
    });
    const result = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(result.formFieldValues["t1"]).toBe("ProjectA");
    expect(result.initialFormFieldValues["t1"]).toBe("ProjectA");
  });
});

describe("SCS-20 — initialBranchValues matches branchValues at load time", () => {
  it("sets initialBranchValues to a copy of branchValues from saved data", async () => {
    const assignment = {
      required: null,
      show_on_submit: true,
      expense_form_field_templates: {
        id: "t1",
        name: "Type",
        field_type: "select",
        required: false,
        placeholder: null,
        help_text: null,
        validation_rules: null,
        options: ["Alpha"],
        show_on_submit: true,
      },
    };
    const savedBranchValue = { template_id: null, branch_field_id: "b1", field_value: "BranchData" };
    const sb = mockSupabase({
      categories: [{ id: "cat-1" }],
      assignments: [assignment],
      branches: [makeBranch("b1", "t1", "Alpha")],
      values: [savedBranchValue],
    });
    const result = await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "Travel");
    expect(result.branchValues["b1"]).toBe("BranchData");
    expect(result.initialBranchValues["b1"]).toBe("BranchData");
  });
});
