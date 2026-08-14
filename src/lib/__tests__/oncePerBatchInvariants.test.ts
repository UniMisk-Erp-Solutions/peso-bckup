/**
 * Regression tests for once-per-batch field behavior.
 * Covers the invariants documented in template-level-once-per-batch-fields.md
 *
 * Key rules enforced:
 *  - Once-per-batch template → appears in plan.shared only, never in plan.perLine
 *  - Per-line template → appears in plan.perLine only, never in plan.shared
 *  - Same template ID across N categories → ONE shared entry listing all categories
 *  - Different template IDs that happen to share a name → stay separate
 *  - batch_entry_mode takes precedence over ask_once_per_batch
 *  - Required validation reads template.required (not is_required)
 */

import { describe, it, expect } from "vitest";
import {
  buildBatchFieldPlan,
  resolveAssignmentBatchMode,
  applyBatchFieldPlanToLines,
  getPerLineAssignmentsForCategory,
  getPerLineSelectTemplateIds,
  type BatchFieldAssignment,
  type BatchFieldPlan,
} from "../batchFieldPlan";
import {
  validateBatchCustomFieldsFromPlan,
  type LineCustomFieldInput,
} from "../expenseBatchValidation";

type SharedValues = Record<string, { fields: Record<string, string>; branches: Record<string, string> }>;
type BatchSharedFormValues = SharedValues;

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeAssignment(o: {
  templateId: string;
  categoryId: string;
  categoryName?: string;
  required?: boolean;
  batchEntryMode?: "once_per_batch" | "per_line" | null;
  askOncePerBatch?: boolean;
  fieldType?: string;
}): BatchFieldAssignment {
  return {
    id: `asgn-${o.templateId}-${o.categoryId}`,
    category_id: o.categoryId,
    category_name: o.categoryName ?? `Cat-${o.categoryId}`,
    display_order: 0,
    show_on_submit: true,
    ask_once_per_batch: o.askOncePerBatch ?? null,
    template: {
      id: o.templateId,
      name: `Field-${o.templateId}`,
      field_type: o.fieldType ?? "text",
      required: o.required ?? false,
      placeholder: null,
      help_text: null,
      options: null,
      show_on_submit: true,
      batch_entry_mode: o.batchEntryMode ?? null,
    },
  };
}

function makeLine(category: string, values?: Record<string, string>): LineCustomFieldInput {
  return {
    lineIndex: 0,
    lineLabel: `Line (${category})`,
    category,
    formFieldValues: values ?? {},
    branchValues: {},
  };
}

const EMPTY_BRANCHES = new Map<string, []>();

// ─── resolveAssignmentBatchMode ───────────────────────────────────────────────

describe("resolveAssignmentBatchMode", () => {
  it("T-R1: batch_entry_mode='once_per_batch' → once_per_batch (regardless of legacy flag)", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "once_per_batch", askOncePerBatch: false });
    expect(resolveAssignmentBatchMode(a)).toBe("once_per_batch");
  });

  it("T-R2: batch_entry_mode='per_line' → per_line (regardless of legacy flag)", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "per_line", askOncePerBatch: true });
    expect(resolveAssignmentBatchMode(a)).toBe("per_line");
  });

  it("T-R3: batch_entry_mode=null + ask_once_per_batch=true → once_per_batch (legacy fallback)", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: null, askOncePerBatch: true });
    expect(resolveAssignmentBatchMode(a)).toBe("once_per_batch");
  });

  it("T-R4: batch_entry_mode=null + ask_once_per_batch=false → per_line (default)", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: null, askOncePerBatch: false });
    expect(resolveAssignmentBatchMode(a)).toBe("per_line");
  });

  it("T-R5: template mode once_per_batch + legacy false → once_per_batch (template wins)", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "once_per_batch", askOncePerBatch: false });
    expect(resolveAssignmentBatchMode(a)).toBe("once_per_batch");
  });

  it("T-R6: template mode per_line + legacy true → per_line (template wins)", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "per_line", askOncePerBatch: true });
    expect(resolveAssignmentBatchMode(a)).toBe("per_line");
  });
});

// ─── plan structure invariants ────────────────────────────────────────────────

describe("buildBatchFieldPlan — plan structure", () => {
  it("T-P1: per-line template appears in plan.perLine only", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "per_line" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    expect(plan.perLine).toHaveLength(1);
    expect(plan.shared).toHaveLength(0);
    expect(plan.perLine[0].assignment.template.id).toBe("t1");
  });

  it("T-P2: once-per-batch template appears in plan.shared only", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    expect(plan.shared).toHaveLength(1);
    expect(plan.perLine).toHaveLength(0);
    expect(plan.shared[0].templateId).toBe("t1");
  });

  it("T-P3: once-per-batch template never appears in plan.perLine", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const inPerLine = plan.perLine.some((p) => p.assignment.template.id === "t1");
    expect(inPerLine).toBe(false);
  });

  it("T-P4: same template ID assigned to two categories → one shared entry", () => {
    const a1 = makeAssignment({ templateId: "t-shared", categoryId: "c1", categoryName: "Material Purchase", batchEntryMode: "once_per_batch" });
    const a2 = makeAssignment({ templateId: "t-shared", categoryId: "c2", categoryName: "Laptop Rent",       batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1", "c2"]));
    expect(plan.shared).toHaveLength(1);
    expect(plan.shared[0].categoryIds).toContain("c1");
    expect(plan.shared[0].categoryIds).toContain("c2");
    expect(plan.shared[0].categoryNames).toContain("Material Purchase");
    expect(plan.shared[0].categoryNames).toContain("Laptop Rent");
  });

  it("T-P5: same template ID assigned to five categories → one shared entry listing all five", () => {
    const cats = ["c1","c2","c3","c4","c5"];
    const assignments = cats.map((c, i) =>
      makeAssignment({ templateId: "t-multi", categoryId: c, categoryName: `Cat${i+1}`, batchEntryMode: "once_per_batch" })
    );
    const plan = buildBatchFieldPlan(assignments, new Set(cats));
    expect(plan.shared).toHaveLength(1);
    expect(plan.shared[0].categoryIds).toHaveLength(5);
  });

  it("T-P6: two different template IDs with same name remain separate shared entries", () => {
    const a1 = makeAssignment({ templateId: "t-A", categoryId: "c1", batchEntryMode: "once_per_batch" });
    const a2 = makeAssignment({ templateId: "t-B", categoryId: "c1", batchEntryMode: "once_per_batch" });
    // Give them the same display name
    a1.template.name = "Project ID";
    a2.template.name = "Project ID";
    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1"]));
    expect(plan.shared).toHaveLength(2);
    const ids = plan.shared.map((s) => s.templateId).sort();
    expect(ids).toEqual(["t-A", "t-B"]);
  });

  it("T-P7: once-per-batch and per-line templates for same category are split correctly", () => {
    const shared = makeAssignment({ templateId: "t-shared", categoryId: "c1", batchEntryMode: "once_per_batch" });
    const perLine = makeAssignment({ templateId: "t-perline", categoryId: "c1", batchEntryMode: "per_line" });
    const plan = buildBatchFieldPlan([shared, perLine], new Set(["c1"]));
    expect(plan.shared).toHaveLength(1);
    expect(plan.perLine).toHaveLength(1);
    expect(plan.shared[0].templateId).toBe("t-shared");
    expect(plan.perLine[0].assignment.template.id).toBe("t-perline");
  });

  it("T-P8: assignments for inactive category IDs are excluded from plan", () => {
    const active   = makeAssignment({ templateId: "t-active",   categoryId: "c1", batchEntryMode: "once_per_batch" });
    const inactive = makeAssignment({ templateId: "t-inactive", categoryId: "c2", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([active, inactive], new Set(["c1"])); // only c1 is active
    expect(plan.shared).toHaveLength(1);
    expect(plan.shared[0].templateId).toBe("t-active");
  });

  it("T-P9: legacy ask_once_per_batch=true with null batch_entry_mode → goes into shared", () => {
    const a = makeAssignment({ templateId: "t-legacy", categoryId: "c1", batchEntryMode: null, askOncePerBatch: true });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    expect(plan.shared).toHaveLength(1);
    expect(plan.perLine).toHaveLength(0);
  });
});

// ─── getPerLineAssignmentsForCategory ─────────────────────────────────────────

describe("getPerLineAssignmentsForCategory", () => {
  it("T-G1: returns per-line assignments for the given category", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "per_line" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = getPerLineAssignmentsForCategory(plan, "c1");
    expect(result).toHaveLength(1);
    expect(result[0].template.id).toBe("t1");
  });

  it("T-G2: once-per-batch template is never returned by getPerLineAssignmentsForCategory", () => {
    const shared = makeAssignment({ templateId: "t-shared", categoryId: "c1", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([shared], new Set(["c1"]));
    const result = getPerLineAssignmentsForCategory(plan, "c1");
    expect(result).toHaveLength(0);
  });

  it("T-G3: returns empty array for a category with no per-line assignments", () => {
    const plan: BatchFieldPlan = { shared: [], perLine: [] };
    expect(getPerLineAssignmentsForCategory(plan, "c1")).toHaveLength(0);
  });

  it("T-G4: does not return per-line assignments for a different category", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", batchEntryMode: "per_line" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    expect(getPerLineAssignmentsForCategory(plan, "c2")).toHaveLength(0);
  });
});

// ─── getPerLineSelectTemplateIds ──────────────────────────────────────────────

describe("getPerLineSelectTemplateIds", () => {
  it("T-S1: returns template ID only for select-type per-line fields", () => {
    const text   = makeAssignment({ templateId: "t-text",   categoryId: "c1", batchEntryMode: "per_line", fieldType: "text" });
    const select = makeAssignment({ templateId: "t-select", categoryId: "c1", batchEntryMode: "per_line", fieldType: "select" });
    const plan = buildBatchFieldPlan([text, select], new Set(["c1"]));
    const ids = getPerLineSelectTemplateIds(plan, "c1");
    expect(ids).toEqual(["t-select"]);
  });

  it("T-S2: once-per-batch select template is not included", () => {
    const a = makeAssignment({ templateId: "t-shared-select", categoryId: "c1", batchEntryMode: "once_per_batch", fieldType: "select" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    expect(getPerLineSelectTemplateIds(plan, "c1")).toHaveLength(0);
  });
});

// ─── applyBatchFieldPlanToLines ───────────────────────────────────────────────

describe("applyBatchFieldPlanToLines", () => {
  const catIdByName = { "Material Purchase": "c1", "Laptop Rent": "c2", "Food": "c3" };
  const catNameById = { c1: "Material Purchase", c2: "Laptop Rent", c3: "Food" };

  it("T-A1: shared value is copied to all applicable lines", () => {
    const a1 = makeAssignment({ templateId: "t-shared", categoryId: "c1", batchEntryMode: "once_per_batch" });
    const a2 = makeAssignment({ templateId: "t-shared", categoryId: "c2", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1", "c2"]));
    const sharedValues: BatchSharedFormValues = {
      "t-shared": { fields: { "t-shared": "PROJECT-001" }, branches: {} },
    };
    const lines = [
      { clientId: "l1", title: "", amount: 0, category: "Material Purchase" },
      { clientId: "l2", title: "", amount: 0, category: "Laptop Rent" },
    ];
    const result = applyBatchFieldPlanToLines(lines, plan, sharedValues, catNameById, catIdByName);
    expect(result[0].formFieldValues?.["t-shared"]).toBe("PROJECT-001");
    expect(result[1].formFieldValues?.["t-shared"]).toBe("PROJECT-001");
  });

  it("T-A2: shared value is NOT copied to lines in an unrelated category", () => {
    const a = makeAssignment({ templateId: "t-shared", categoryId: "c1", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const sharedValues: BatchSharedFormValues = {
      "t-shared": { fields: { "t-shared": "PROJECT-001" }, branches: {} },
    };
    const lines = [
      { clientId: "l1", title: "", amount: 0, category: "Material Purchase" },
      { clientId: "l2", title: "", amount: 0, category: "Food" },
    ];
    const result = applyBatchFieldPlanToLines(lines, plan, sharedValues, catNameById, catIdByName);
    expect(result[0].formFieldValues?.["t-shared"]).toBe("PROJECT-001");
    expect(result[1].formFieldValues?.["t-shared"]).toBeUndefined();
  });
});

// ─── validation: required column name fix ─────────────────────────────────────

describe("validateBatchCustomFieldsFromPlan — required column correctness", () => {
  it("T-V1: shared required field (template.required=true) fails when empty", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", required: true, batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine("Cat-c1")],
      plan,
      batchSharedFormValues: {},
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(false);
  });

  it("T-V2: shared optional field (template.required=false) passes when empty", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", required: false, batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine("Cat-c1")],
      plan,
      batchSharedFormValues: {},
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(true);
  });

  it("T-V3: per-line required field (template.required=true) fails when empty", () => {
    const a = makeAssignment({ templateId: "t-pl", categoryId: "c1", required: true, batchEntryMode: "per_line" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine("Cat-c1", {})],
      plan,
      batchSharedFormValues: {},
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(false);
  });

  it("T-V4: shared required validated once — filling it satisfies both categories", () => {
    const a1 = makeAssignment({ templateId: "t-s", categoryId: "c1", categoryName: "Travel", required: true, batchEntryMode: "once_per_batch" });
    const a2 = makeAssignment({ templateId: "t-s", categoryId: "c2", categoryName: "Hotel",  required: true, batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1", "c2"]));
    const shared: BatchSharedFormValues = { "t-s": { fields: { "t-s": "value" }, branches: {} } };
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine("Travel"), makeLine("Hotel")],
      plan,
      batchSharedFormValues: shared,
      categoryIdByName: { Travel: "c1", Hotel: "c2" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(true);
  });

  it("T-V5: shared required field message does not say 'for batch' per-line style", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", categoryName: "Travel", required: true, batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine("Travel")],
      plan,
      batchSharedFormValues: {},
      categoryIdByName: { Travel: "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    if (!result.ok) {
      expect(result.message).toContain("Field-t1");
      expect(result.message).toContain("batch");
    }
  });
});

// ─── shared field label shows all categories ──────────────────────────────────

describe("SharedBatchField category labels", () => {
  it("T-L1: shared field for one category lists that category name", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", categoryName: "Material Purchase", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    expect(plan.shared[0].categoryNames).toEqual(["Material Purchase"]);
  });

  it("T-L2: shared field for three categories lists all three names", () => {
    const a1 = makeAssignment({ templateId: "t1", categoryId: "c1", categoryName: "Alpha", batchEntryMode: "once_per_batch" });
    const a2 = makeAssignment({ templateId: "t1", categoryId: "c2", categoryName: "Beta",  batchEntryMode: "once_per_batch" });
    const a3 = makeAssignment({ templateId: "t1", categoryId: "c3", categoryName: "Gamma", batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a1, a2, a3], new Set(["c1","c2","c3"]));
    expect(plan.shared[0].categoryNames).toContain("Alpha");
    expect(plan.shared[0].categoryNames).toContain("Beta");
    expect(plan.shared[0].categoryNames).toContain("Gamma");
  });
});
