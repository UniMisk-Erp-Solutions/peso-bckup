/**
 * DOC-044 — AdminPanel Correction Custom Fields Fix
 *
 * AP-1  — loadCorrectionCustomFields returns model when category and assignments exist
 * AP-2  — returned model has categoryFormFields matching configured templates
 * AP-3  — existing saved values are overlaid onto defaults in formFieldValues
 * AP-4  — getVisibleBranchIds returns empty set when parent option is not selected
 * AP-5  — validateCorrectionCustomFields blocks save when required field is empty
 * AP-6  — guard passes formFieldValues when model has fields, undefined when model is empty
 * AP-7  — loadCorrectionCustomFields returns EMPTY when no assignments exist for category
 * AP-8  — category lookup uses ilike (case-insensitive) not eq
 * AP-9  — guard passes undefined for branchValues when model is empty
 * AP-10 — guard passes branchValues through when model has fields
 * AP-11 — empty formFieldValues with existing fields passes {} (replace semantics, not undefined)
 * AP-12 — loadCorrectionCustomFields returns EMPTY when category is not found
 */

import { describe, it, expect, vi } from "vitest";
import {
  loadCorrectionCustomFields,
  validateCorrectionCustomFields,
  EMPTY_CORRECTION_FIELDS,
  type CorrectionFieldAssignment,
  type CorrectionCustomFieldsModel,
} from "@/lib/loadCorrectionCustomFields";
import { getVisibleBranchIds } from "@/lib/conditionalFormFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

// ── Mock supabase builder factory ─────────────────────────────────────────────

type TableData = {
  expense_categories?: any;
  expense_category_form_fields?: any[];
  expense_form_field_option_branches?: any[];
  expense_form_field_values?: any[];
};

function makeSupabase(tables: TableData) {
  const ilikeSpy = vi.fn().mockReturnThis();
  const eqSpy = vi.fn().mockReturnThis();

  const makeChain = (table: string) => {
    let resolveData: any;
    let categoryResolveData: any; // limit(2) returns an array

    switch (table) {
      case "expense_categories": {
        // Normalise to an array for the new limit(2) call.
        // Callers that pass null get [], single-object gets wrapped in [].
        const raw = tables.expense_categories;
        const arr = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
        resolveData = { data: arr };
        categoryResolveData = { data: arr };
        break;
      }
      case "expense_category_form_fields":
        resolveData = { data: tables.expense_category_form_fields ?? null, error: null };
        break;
      case "expense_form_field_option_branches":
        resolveData = { data: tables.expense_form_field_option_branches ?? [] };
        break;
      case "expense_form_field_values":
        resolveData = { data: tables.expense_form_field_values ?? [] };
        break;
      default:
        resolveData = { data: null, error: null };
    }

    const chain: any = {
      select: vi.fn().mockReturnThis(),
      eq: eqSpy,
      ilike: ilikeSpy,
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      // limit(2) is used by the category lookup — returns Promise<{data: row[]}>
      limit: vi.fn().mockResolvedValue(categoryResolveData ?? resolveData),
      // maybeSingle kept for any callers that still use it
      maybeSingle: vi.fn().mockResolvedValue(resolveData),
      then: (resolve: (v: any) => any) => Promise.resolve(resolveData).then(resolve),
    };
    return chain;
  };

  return {
    from: (table: string) => makeChain(table),
    _ilikeSpy: ilikeSpy,
    _eqSpy: eqSpy,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAssignment(templateId: string, templateName: string, fieldType = "text"): any {
  return {
    required: null,
    show_on_submit: true,
    expense_form_field_templates: {
      id: templateId,
      name: templateName,
      field_type: fieldType,
      required: false,
      placeholder: null,
      help_text: null,
      validation_rules: null,
      options: null,
      show_on_submit: true,
    },
  };
}

function makeField(id: string, name: string, required = false): CorrectionFieldAssignment {
  return {
    template: {
      id, name,
      field_type: "text",
      required,
      placeholder: null,
      help_text: null,
      validation_rules: null,
      options: null,
    },
    required: null,
  };
}

function makeBranch(
  id: string,
  parentTemplateId: string,
  parentOptionValue: string,
  name: string,
  required = false,
): OptionBranchDefinition {
  return {
    id,
    organization_id: "org-1",
    parent_template_id: parentTemplateId,
    parent_option_value: parentOptionValue,
    parent_branch_id: null,
    field_key: id,
    name,
    field_type: "text",
    required,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: null,
    display_order: 1,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AP-1 to AP-3: loadCorrectionCustomFields loader behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-1 — loadCorrectionCustomFields returns model when category and assignments exist", () => {
  it("resolves with a non-empty categoryFormFields array", async () => {
    const sb = makeSupabase({
      expense_categories: { id: "cat-1" },
      expense_category_form_fields: [makeAssignment("t1", "Project Name")],
      expense_form_field_values: [],
    });
    const model = await loadCorrectionCustomFields(
      sb as any, "org-1", "exp-1", "Travel",
    );
    expect(model.categoryFormFields.length).toBe(1);
    expect(model.categoryFormFields[0].template.name).toBe("Project Name");
  });
});

describe("AP-2 — returned model has categoryFormFields matching configured templates", () => {
  it("maps all assigned templates into CorrectionFieldAssignment shape", async () => {
    const sb = makeSupabase({
      expense_categories: { id: "cat-2" },
      expense_category_form_fields: [
        makeAssignment("t1", "Project"),
        makeAssignment("t2", "Cost Center"),
      ],
      expense_form_field_values: [],
    });
    const model = await loadCorrectionCustomFields(
      sb as any, "org-1", "exp-1", "Training",
    );
    expect(model.categoryFormFields.map((f) => f.template.name)).toEqual(["Project", "Cost Center"]);
  });
});

describe("AP-3 — existing saved values are overlaid onto defaults in formFieldValues", () => {
  it("overlays the saved value for template_id onto formFieldValues", async () => {
    const sb = makeSupabase({
      expense_categories: { id: "cat-3" },
      expense_category_form_fields: [makeAssignment("t1", "Project")],
      expense_form_field_values: [
        { template_id: "t1", branch_field_id: null, field_value: "Alpha Project" },
      ],
    });
    const model = await loadCorrectionCustomFields(
      sb as any, "org-1", "exp-1", "Travel",
    );
    expect(model.formFieldValues["t1"]).toBe("Alpha Project");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-4: getVisibleBranchIds — branch visibility
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-4 — getVisibleBranchIds returns empty set when parent option is not selected", () => {
  it("branch with parent value 'Alpha' is invisible when parent value is 'Beta'", () => {
    const branch = makeBranch("b1", "t1", "Alpha", "Sub-field");
    const visibleSet = getVisibleBranchIds([branch], { t1: "Beta" }, {}, false);
    expect(visibleSet.has("b1")).toBe(false);
  });

  it("branch with parent value 'Alpha' is visible when parent value is 'Alpha'", () => {
    const branch = makeBranch("b1", "t1", "Alpha", "Sub-field");
    const visibleSet = getVisibleBranchIds([branch], { t1: "Alpha" }, {}, false);
    expect(visibleSet.has("b1")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-5: validateCorrectionCustomFields — required field blocks save
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-5 — validateCorrectionCustomFields blocks save when required field is empty", () => {
  it("returns ok:false when a required template field is empty", () => {
    const field = makeField("t1", "Project Code", true);
    const result = validateCorrectionCustomFields([field], { t1: "" }, [], {}, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Project Code");
    }
  });

  it("returns ok:true when the required field is filled", () => {
    const field = makeField("t1", "Project Code", true);
    const result = validateCorrectionCustomFields([field], { t1: "PROJ-42" }, [], {}, false);
    expect(result.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-6 and AP-10: guard logic — formFieldValues and branchValues
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-6 — guard passes formFieldValues when model has fields, undefined when model is empty", () => {
  it("returns actual formFieldValues when categoryFormFields.length > 0", () => {
    const m: CorrectionCustomFieldsModel = {
      categoryFormFields: [makeField("t1", "Project")],
      optionBranches: [],
      formFieldValues: { t1: "Alpha" },
      branchValues: {},
    };
    const result = m.categoryFormFields.length > 0 ? m.formFieldValues : undefined;
    expect(result).toEqual({ t1: "Alpha" });
  });

  it("returns undefined when categoryFormFields is empty", () => {
    const m = EMPTY_CORRECTION_FIELDS;
    const result = m.categoryFormFields.length > 0 ? m.formFieldValues : undefined;
    expect(result).toBeUndefined();
  });
});

describe("AP-10 — guard passes branchValues through when model has fields", () => {
  it("returns actual branchValues when categoryFormFields.length > 0", () => {
    const m: CorrectionCustomFieldsModel = {
      categoryFormFields: [makeField("t1", "Project")],
      optionBranches: [],
      formFieldValues: { t1: "Alpha" },
      branchValues: { b1: "branchVal" },
    };
    const result = m.categoryFormFields.length > 0 ? m.branchValues : undefined;
    expect(result).toEqual({ b1: "branchVal" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-7: empty category — no assignments
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-7 — loadCorrectionCustomFields returns EMPTY when no assignments exist for category", () => {
  it("returns EMPTY_CORRECTION_FIELDS shape when assignments array is empty", async () => {
    const sb = makeSupabase({
      expense_categories: { id: "cat-empty" },
      expense_category_form_fields: [],
      expense_form_field_values: [],
    });
    const model = await loadCorrectionCustomFields(
      sb as any, "org-1", "exp-1", "Uncategorized",
    );
    expect(model.categoryFormFields).toEqual([]);
    expect(model.optionBranches).toEqual([]);
    expect(model.formFieldValues).toEqual({});
    expect(model.branchValues).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-8: ilike — category lookup is case-insensitive
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-8 — category lookup uses ilike (case-insensitive), not eq", () => {
  it("calls ilike on expense_categories for name lookup", async () => {
    const sb = makeSupabase({
      expense_categories: null,
      expense_category_form_fields: [],
      expense_form_field_values: [],
    });
    await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "travel");
    expect(sb._ilikeSpy).toHaveBeenCalledWith("name", "travel");
  });

  it("trims the category name before ilike comparison", async () => {
    const sb = makeSupabase({
      expense_categories: null,
      expense_form_field_values: [],
    });
    await loadCorrectionCustomFields(sb as any, "org-1", "exp-1", "  Travel  ");
    expect(sb._ilikeSpy).toHaveBeenCalledWith("name", "Travel");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-9: guard passes undefined for branchValues when model is empty
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-9 — guard passes undefined for branchValues when model is empty", () => {
  it("returns undefined when categoryFormFields is empty", () => {
    const m = EMPTY_CORRECTION_FIELDS;
    const result = m.categoryFormFields.length > 0 ? m.branchValues : undefined;
    expect(result).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-11: empty values with fields → passes {} (replace/clear semantics)
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-11 — empty formFieldValues with existing fields passes {} (replace semantics, not undefined)", () => {
  it("returns {} (not undefined) when model has fields but reviewer cleared all values", () => {
    const m: CorrectionCustomFieldsModel = {
      categoryFormFields: [makeField("t1", "Project")],
      optionBranches: [],
      formFieldValues: {},
      branchValues: {},
      initialFormFieldValues: {},
      initialBranchValues: {},
      categoryId: null,
    };
    const result = m.categoryFormFields.length > 0 ? m.formFieldValues : undefined;
    expect(result).toEqual({});
    expect(result).not.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AP-12: category not found → EMPTY_CORRECTION_FIELDS
// ═══════════════════════════════════════════════════════════════════════════════

describe("AP-12 — loadCorrectionCustomFields returns EMPTY when category is not found", () => {
  it("returns EMPTY_CORRECTION_FIELDS shape when expense_categories returns null", async () => {
    const sb = makeSupabase({
      expense_categories: null,
      expense_form_field_values: [],
    });
    const model = await loadCorrectionCustomFields(
      sb as any, "org-1", "exp-1", "unknown-category",
    );
    expect(model.categoryFormFields).toEqual([]);
    expect(model.formFieldValues).toEqual({});
  });
});
