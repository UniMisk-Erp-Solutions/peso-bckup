/**
 * Tests for the pure batchFieldPlan model.
 * Tests 49–58 (Phase E spec).
 */

import { describe, it, expect } from "vitest";
import {
  buildBatchFieldPlan,
  resolveAssignmentBatchMode,
  isAssignmentVisible,
  applyBatchFieldPlanToLines,
  getActiveCategoryIds,
} from "../batchFieldPlan";
import type { BatchFieldAssignment } from "../batchFieldPlan";

function makeAssignment(overrides: Partial<BatchFieldAssignment> & {
  templateId: string;
  categoryId: string;
}): BatchFieldAssignment {
  return {
    id: `asgn-${overrides.templateId}-${overrides.categoryId}`,
    category_id: overrides.categoryId,
    category_name: overrides.category_name ?? `Cat-${overrides.categoryId}`,
    display_order: 1,
    show_on_submit: true,
    ask_once_per_batch: overrides.ask_once_per_batch ?? null,
    template: {
      id: overrides.templateId,
      name: `Template ${overrides.templateId}`,
      field_type: "text",
      label: null,
      placeholder: null,
      is_required: false,
      options: null,
      show_on_submit: true,
      batch_entry_mode: overrides.template?.batch_entry_mode ?? null,
      ...overrides.template,
    },
    ...overrides,
  };
}

// T49: resolveAssignmentBatchMode — new column takes precedence
describe("resolveAssignmentBatchMode", () => {
  it("T49: returns once_per_batch when template.batch_entry_mode = once_per_batch", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      template: { id: "t1", batch_entry_mode: "once_per_batch" },
    });
    expect(resolveAssignmentBatchMode(a)).toBe("once_per_batch");
  });

  it("T50: returns per_line when template.batch_entry_mode = per_line", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      template: { id: "t1", batch_entry_mode: "per_line" },
    });
    expect(resolveAssignmentBatchMode(a)).toBe("per_line");
  });

  it("T51: falls back to ask_once_per_batch=true when template column is null", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      ask_once_per_batch: true,
      template: { id: "t1", batch_entry_mode: null },
    });
    expect(resolveAssignmentBatchMode(a)).toBe("once_per_batch");
  });

  it("T52: returns per_line as default when both columns are null/false", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      ask_once_per_batch: false,
      template: { id: "t1", batch_entry_mode: null },
    });
    expect(resolveAssignmentBatchMode(a)).toBe("per_line");
  });
});

// T53: buildBatchFieldPlan — same template across two categories → asked once
describe("buildBatchFieldPlan", () => {
  it("T53: dedupes same template used in two categories into a single SharedBatchField", () => {
    const a1 = makeAssignment({
      templateId: "t-shared",
      categoryId: "c1",
      category_name: "Travel",
      template: { id: "t-shared", batch_entry_mode: "once_per_batch" },
    });
    const a2 = makeAssignment({
      templateId: "t-shared",
      categoryId: "c2",
      category_name: "Meals",
      template: { id: "t-shared", batch_entry_mode: "once_per_batch" },
    });

    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1", "c2"]));
    expect(plan.shared).toHaveLength(1);
    expect(plan.shared[0].templateId).toBe("t-shared");
    expect(plan.shared[0].categoryIds).toContain("c1");
    expect(plan.shared[0].categoryIds).toContain("c2");
    expect(plan.perLine).toHaveLength(0);
  });

  it("T54: per_line template with same ID in two categories → two perLine entries", () => {
    const a1 = makeAssignment({
      templateId: "t-per",
      categoryId: "c1",
      template: { id: "t-per", batch_entry_mode: "per_line" },
    });
    const a2 = makeAssignment({
      templateId: "t-per",
      categoryId: "c2",
      template: { id: "t-per", batch_entry_mode: "per_line" },
    });

    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1", "c2"]));
    expect(plan.shared).toHaveLength(0);
    expect(plan.perLine).toHaveLength(2);
  });

  it("T55: assignments for categories not in activeCategoryIds are excluded", () => {
    const a1 = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      template: { id: "t1", batch_entry_mode: "once_per_batch" },
    });
    const a2 = makeAssignment({
      templateId: "t2",
      categoryId: "c3", // not active
      template: { id: "t2", batch_entry_mode: "once_per_batch" },
    });

    const plan = buildBatchFieldPlan([a1, a2], new Set(["c1"]));
    expect(plan.shared).toHaveLength(1);
    expect(plan.shared[0].templateId).toBe("t1");
  });

  it("T56: hidden assignments (show_on_submit=false) are excluded", () => {
    const a = makeAssignment({
      templateId: "t1",
      categoryId: "c1",
      show_on_submit: false,
      template: { id: "t1", batch_entry_mode: "once_per_batch" },
    });
    const plan = buildBatchFieldPlan([a], new Set(["c1"]));
    expect(plan.shared).toHaveLength(0);
    expect(plan.perLine).toHaveLength(0);
  });

  it("T57: mixed once_per_batch and per_line from same category split correctly", () => {
    const once = makeAssignment({
      id: "once-1",
      templateId: "t-once",
      categoryId: "c1",
      template: { id: "t-once", batch_entry_mode: "once_per_batch" },
    });
    const perLine = makeAssignment({
      id: "per-1",
      templateId: "t-per",
      categoryId: "c1",
      template: { id: "t-per", batch_entry_mode: "per_line" },
    });

    const plan = buildBatchFieldPlan([once, perLine], new Set(["c1"]));
    expect(plan.shared).toHaveLength(1);
    expect(plan.perLine).toHaveLength(1);
  });
});

// T58: applyBatchFieldPlanToLines merges template values into lines
describe("applyBatchFieldPlanToLines", () => {
  it("T58: merges shared field values into matching lines", () => {
    const a1 = makeAssignment({
      templateId: "t-once",
      categoryId: "c1",
      category_name: "Travel",
      template: { id: "t-once", batch_entry_mode: "once_per_batch" },
    });
    const plan = buildBatchFieldPlan([a1], new Set(["c1"]));

    const lines = [
      { category: "Travel", formFieldValues: {}, branchValues: {} },
      { category: "Meals", formFieldValues: {}, branchValues: {} },
    ];

    const sharedValues = {
      "t-once": { fields: { destination: "Mumbai" }, branches: {} },
    };

    const result = applyBatchFieldPlanToLines(
      lines,
      plan,
      sharedValues,
      { "c1": "Travel" },
      { "Travel": "c1" },
    );

    expect(result[0].formFieldValues).toEqual({ destination: "Mumbai" });
    expect(result[1].formFieldValues).toEqual({}); // Meals not in plan
  });
});

// getActiveCategoryIds
describe("getActiveCategoryIds", () => {
  it("returns correct set from lines", () => {
    const result = getActiveCategoryIds(
      [{ category: "Travel" }, { category: "Meals" }, { category: "Travel" }],
      { Travel: "c1", Meals: "c2" },
    );
    expect(result).toEqual(new Set(["c1", "c2"]));
  });

  it("skips lines with unknown category", () => {
    const result = getActiveCategoryIds(
      [{ category: "Unknown" }],
      { Travel: "c1" },
    );
    expect(result.size).toBe(0);
  });
});
