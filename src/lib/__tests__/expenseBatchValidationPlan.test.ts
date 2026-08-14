/**
 * Tests for validateBatchCustomFieldsFromPlan — plan-based batch custom field validation.
 * Tests 69–80 (Phase G spec).
 */

import { describe, it, expect } from "vitest";
import {
  validateBatchCustomFieldsFromPlan,
  type BatchSharedFormValues,
  type LineCustomFieldInput,
} from "../expenseBatchValidation";
import {
  buildBatchFieldPlan,
  type BatchFieldAssignment,
  type BatchFieldPlan,
} from "../batchFieldPlan";

function makeAssignment(overrides: {
  templateId: string;
  categoryId: string;
  categoryName?: string;
  isRequired?: boolean;
  batchEntryMode?: "once_per_batch" | "per_line" | null;
  fieldType?: string;
}): BatchFieldAssignment {
  return {
    id: `asgn-${overrides.templateId}-${overrides.categoryId}`,
    category_id: overrides.categoryId,
    category_name: overrides.categoryName ?? `Cat-${overrides.categoryId}`,
    display_order: 1,
    show_on_submit: true,
    ask_once_per_batch: null,
    template: {
      id: overrides.templateId,
      name: `Template-${overrides.templateId}`,
      field_type: overrides.fieldType ?? "text",
      required: overrides.isRequired ?? false,
      placeholder: null,
      help_text: null,
      options: null,
      show_on_submit: true,
      batch_entry_mode: overrides.batchEntryMode ?? null,
    },
  };
}

function makeLine(overrides: Partial<LineCustomFieldInput> & { category: string }): LineCustomFieldInput {
  return {
    lineIndex: 0,
    lineLabel: overrides.lineLabel ?? "Line 1",
    category: overrides.category,
    formFieldValues: overrides.formFieldValues ?? {},
    branchValues: overrides.branchValues ?? {},
  };
}

const EMPTY_PLAN: BatchFieldPlan = { shared: [], perLine: [] };
const EMPTY_BRANCHES = new Map<string, []>();
const EMPTY_SHARED: BatchSharedFormValues = {};

// ── T69: configLoaded guard ───────────────────────────────────────────────────
describe("validateBatchCustomFieldsFromPlan — configLoaded guard", () => {
  it("T69: returns error when configLoaded is false", () => {
    const result = validateBatchCustomFieldsFromPlan({
      lines: [],
      plan: EMPTY_PLAN,
      batchSharedFormValues: EMPTY_SHARED,
      categoryIdByName: {},
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: false,
    });
    expect(result.ok).toBe(false);
  });
});

// ── T70: empty plan passes ────────────────────────────────────────────────────
describe("validateBatchCustomFieldsFromPlan — empty plan", () => {
  it("T70: passes when plan is empty and lines have no custom fields", () => {
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Travel" })],
      plan: EMPTY_PLAN,
      batchSharedFormValues: EMPTY_SHARED,
      categoryIdByName: { Travel: "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(true);
  });
});

// ── T71: shared required field missing ───────────────────────────────────────
describe("validateBatchCustomFieldsFromPlan — shared required field", () => {
  it("T71: fails when a shared required field has no value", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      categoryName: "Travel",
      isRequired: true,
      batchEntryMode: "once_per_batch",
    });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Travel" })],
      plan,
      batchSharedFormValues: {},
      categoryIdByName: { Travel: "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Template-t1");
  });

  it("T72: passes when shared required field is filled", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      isRequired: true,
      batchEntryMode: "once_per_batch",
    });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Cat-c1" })],
      plan,
      batchSharedFormValues: { t1: { fields: { t1: "some value" }, branches: {} } },
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(true);
  });
});

// ── T73: per-line required field ──────────────────────────────────────────────
describe("validateBatchCustomFieldsFromPlan — per-line required field", () => {
  it("T73: fails when a per-line required field is missing on a line", () => {
    const a = makeAssignment({
      templateId: "t-pl",
      categoryId: "c1",
      isRequired: true,
      batchEntryMode: "per_line",
    });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Cat-c1", formFieldValues: {} })],
      plan,
      batchSharedFormValues: EMPTY_SHARED,
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Template-t-pl");
  });

  it("T74: passes when a per-line required field is filled on the line", () => {
    const a = makeAssignment({
      templateId: "t-pl",
      categoryId: "c1",
      isRequired: true,
      batchEntryMode: "per_line",
    });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Cat-c1", formFieldValues: { "t-pl": "value" } })],
      plan,
      batchSharedFormValues: EMPTY_SHARED,
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(true);
  });
});

// ── T75: per-line field not validated for wrong category ──────────────────────
describe("validateBatchCustomFieldsFromPlan — category scoping", () => {
  it("T75: per-line field for category c1 is not validated for a c2 line", () => {
    const a = makeAssignment({
      templateId: "t-pl",
      categoryId: "c1",
      isRequired: true,
      batchEntryMode: "per_line",
    });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    // Line belongs to c2, not c1 — so t-pl is not required here
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Cat-c2", formFieldValues: {} })],
      plan,
      batchSharedFormValues: EMPTY_SHARED,
      categoryIdByName: { "Cat-c2": "c2" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(true);
  });
});

// ── T76: non-required shared field with no value passes ───────────────────────
describe("validateBatchCustomFieldsFromPlan — optional fields", () => {
  it("T76: non-required shared field passes even when empty", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      isRequired: false,
      batchEntryMode: "once_per_batch",
    });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Cat-c1" })],
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
});

// ── T77: shared field deduped across two categories ───────────────────────────
describe("validateBatchCustomFieldsFromPlan — template deduplication", () => {
  it("T77: same required template across two categories checked once", () => {
    const a1 = makeAssignment({ templateId: "t-shared", categoryId: "c1", categoryName: "Travel", isRequired: true, batchEntryMode: "once_per_batch" });
    const a2 = makeAssignment({ templateId: "t-shared", categoryId: "c2", categoryName: "Meals",  isRequired: true, batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1", "c2"]));
    // Plan should have one shared entry for t-shared
    expect(plan.shared).toHaveLength(1);

    // Providing the value once (keyed by templateId) should satisfy both categories
    const result = validateBatchCustomFieldsFromPlan({
      lines: [
        makeLine({ category: "Travel", lineLabel: "Line 1" }),
        makeLine({ category: "Meals",  lineLabel: "Line 2" }),
      ],
      plan,
      batchSharedFormValues: { "t-shared": { fields: { "t-shared": "filled" }, branches: {} } },
      categoryIdByName: { Travel: "c1", Meals: "c2" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(true);
  });

  it("T78: same required template across two categories fails when value missing", () => {
    const a1 = makeAssignment({ templateId: "t-shared", categoryId: "c1", categoryName: "Travel", isRequired: true, batchEntryMode: "once_per_batch" });
    const a2 = makeAssignment({ templateId: "t-shared", categoryId: "c2", categoryName: "Meals",  isRequired: true, batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1", "c2"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Travel" }), makeLine({ category: "Meals" })],
      plan,
      batchSharedFormValues: {},
      categoryIdByName: { Travel: "c1", Meals: "c2" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(false);
  });
});

// ── T79: whitespace-only value treated as missing ─────────────────────────────
describe("validateBatchCustomFieldsFromPlan — whitespace handling", () => {
  it("T79: shared required field with whitespace-only value fails", () => {
    const a = makeAssignment({ templateId: "t1", categoryId: "c1", isRequired: true, batchEntryMode: "once_per_batch" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Cat-c1" })],
      plan,
      batchSharedFormValues: { t1: { fields: { t1: "   " }, branches: {} } },
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(false);
  });

  it("T80: per-line required field with whitespace-only value fails", () => {
    const a = makeAssignment({ templateId: "t-pl", categoryId: "c1", isRequired: true, batchEntryMode: "per_line" });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    const result = validateBatchCustomFieldsFromPlan({
      lines: [makeLine({ category: "Cat-c1", formFieldValues: { "t-pl": "  " } })],
      plan,
      batchSharedFormValues: EMPTY_SHARED,
      categoryIdByName: { "Cat-c1": "c1" },
      categoryBranches: EMPTY_BRANCHES,
      allowConditionalDropdown: false,
      allowNestedConditional: false,
      configLoaded: true,
    });
    expect(result.ok).toBe(false);
  });
});
