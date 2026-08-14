/**
 * DOC-040 — Batch Required Custom-Field Validation
 *
 * CF-1  — Required per-line field empty → ok: false
 * CF-2  — Required per-line field filled → ok: true
 * CF-3  — Optional per-line field empty → ok: true
 * CF-4  — Required shared (batchOnce) field empty → ok: false
 * CF-5  — Required shared field filled → ok: true
 * CF-6  — Optional shared field empty → ok: true
 * CF-7  — Multiple lines; second line missing required field → error mentions "Line 2" semantics
 * CF-8  — Category with no spec in map → ok: true (graceful no-op)
 * CF-9  — Required branch field visible (parent selected) but empty → ok: false
 * CF-10 — Required branch field visible and filled → ok: true
 * CF-11 — Branch required but parent not selected (not visible) → ok: true
 * CF-12 — allowConditionalDropdown=false → branch check skipped → ok: true
 * CF-13 — configLoaded=false → ok: false (safety guard)
 * CF-14 — Per-line field value "0" (non-empty) → ok: true
 * CF-15 — Per-line field value "  " (whitespace only) → ok: false
 * CF-16 — Shared field whitespace-only value → ok: false
 * CF-17 — show_on_submit=false assignment is excluded by splitAssignmentsByBatchMode → ok: true
 * CF-18 — Assignment-level required=false overrides template required=true → ok: true
 * CF-19 — ask_once_per_batch=null treated as perLine (not batchOnce)
 * CF-20 — ask_once_per_batch=true treated as batchOnce
 * CF-21 — Shared field error message includes category name
 * CF-22 — Per-line error message includes the line label (title)
 */

import { describe, it, expect } from "vitest";
import {
  validateBatchCustomFields,
  type BatchCategoryFieldSpec,
  type LineCustomFieldInput,
} from "@/lib/expenseBatchValidation";
import { splitAssignmentsByBatchMode } from "@/lib/batchFormFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAssignment(opts: {
  templateId: string;
  templateName: string;
  templateRequired?: boolean;
  assignmentRequired?: boolean | null;
  askOncePer?: boolean | null;
  showOnSubmit?: boolean | null;
}) {
  return {
    required: opts.assignmentRequired ?? null,
    ask_once_per_batch: opts.askOncePer ?? false,
    show_on_submit: opts.showOnSubmit ?? true,
    template: {
      id: opts.templateId,
      name: opts.templateName,
      required: opts.templateRequired ?? false,
      show_on_submit: true,
    },
  };
}

function makeSpec(opts: {
  batchOnce?: ReturnType<typeof makeAssignment>[];
  perLine?: ReturnType<typeof makeAssignment>[];
  branches?: OptionBranchDefinition[];
}): BatchCategoryFieldSpec {
  return {
    batchOnce: opts.batchOnce ?? [],
    perLine: opts.perLine ?? [],
    branches: opts.branches ?? [],
  };
}

function makeLine(opts: {
  index?: number;
  label?: string;
  category?: string;
  formFieldValues?: Record<string, string>;
  branchValues?: Record<string, string>;
} = {}): LineCustomFieldInput {
  return {
    lineIndex: opts.index ?? 0,
    lineLabel: opts.label ?? "Taxi",
    category: opts.category ?? "Travel",
    formFieldValues: opts.formFieldValues ?? {},
    branchValues: opts.branchValues ?? {},
  };
}

function makeBranch(opts: {
  id: string;
  parentTemplateId: string;
  parentOptionValue: string;
  required?: boolean;
  fieldType?: OptionBranchDefinition["field_type"];
}): OptionBranchDefinition {
  return {
    id: opts.id,
    organization_id: "org-1",
    parent_template_id: opts.parentTemplateId,
    parent_option_value: opts.parentOptionValue,
    parent_branch_id: null,
    field_key: opts.id,
    name: `Branch ${opts.id}`,
    field_type: opts.fieldType ?? "text",
    required: opts.required ?? false,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: null,
    display_order: 0,
  };
}

const BASE_PARAMS = {
  batchFormFieldsByCategory: {},
  allowConditionalDropdown: true,
  allowNestedConditional: false,
  configLoaded: true,
};

// ═════════════════════════════════════════════════════════════════════════════
// CF-1 to CF-6: per-line and shared field required/optional combinations
// ═════════════════════════════════════════════════════════════════════════════

describe("CF-1 — Required per-line field empty → ok: false", () => {
  it("blocks when a required per-line field has no value", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({ templateId: "t1", templateName: "Project", templateRequired: true })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ formFieldValues: {} })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(false);
  });
});

describe("CF-2 — Required per-line field filled → ok: true", () => {
  it("passes when a required per-line field has a value", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({ templateId: "t1", templateName: "Project", templateRequired: true })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ formFieldValues: { t1: "Alpha" } })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-3 — Optional per-line field empty → ok: true", () => {
  it("passes when an optional per-line field is empty", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({ templateId: "t1", templateName: "Note", templateRequired: false })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ formFieldValues: {} })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-4 — Required shared (batchOnce) field empty → ok: false", () => {
  it("blocks when a required shared field has no value in batchFormFieldsByCategory", () => {
    const spec = makeSpec({
      batchOnce: [makeAssignment({
        templateId: "s1",
        templateName: "Department",
        templateRequired: true,
        askOncePer: true,
      })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine()],
      categoryFieldSpecs: specs,
      batchFormFieldsByCategory: { Travel: {} },
    });
    expect(result.ok).toBe(false);
  });
});

describe("CF-5 — Required shared field filled → ok: true", () => {
  it("passes when a required shared field has a value", () => {
    const spec = makeSpec({
      batchOnce: [makeAssignment({
        templateId: "s1",
        templateName: "Department",
        templateRequired: true,
        askOncePer: true,
      })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine()],
      categoryFieldSpecs: specs,
      batchFormFieldsByCategory: { Travel: { s1: "Engineering" } },
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-6 — Optional shared field empty → ok: true", () => {
  it("passes when an optional shared field is empty", () => {
    const spec = makeSpec({
      batchOnce: [makeAssignment({
        templateId: "s1",
        templateName: "Note",
        templateRequired: false,
        askOncePer: true,
      })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine()],
      categoryFieldSpecs: specs,
      batchFormFieldsByCategory: { Travel: {} },
    });
    expect(result.ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CF-7 to CF-8: multi-line and missing-spec edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe("CF-7 — Multiple lines; second line fails required field", () => {
  it("returns an error message referencing the second line's label", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({ templateId: "t1", templateName: "Cost Center", templateRequired: true })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [
        makeLine({ index: 0, label: "Taxi", formFieldValues: { t1: "CC-101" } }),
        makeLine({ index: 1, label: "Hotel", formFieldValues: {} }),
      ],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Hotel");
      expect(result.message).toContain("Cost Center");
    }
  });
});

describe("CF-8 — Category with no spec in map → ok: true", () => {
  it("skips validation gracefully when category has no spec", () => {
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ category: "Meals" })],
      categoryFieldSpecs: new Map(),
    });
    expect(result.ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CF-9 to CF-12: branch (conditional dropdown) field validation
// ═════════════════════════════════════════════════════════════════════════════

describe("CF-9 — Required branch visible (parent selected) but empty → ok: false", () => {
  it("blocks when a required branch field is visible but has no value", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: true,
    });
    const spec = makeSpec({ branches: [branch] });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [
        makeLine({
          formFieldValues: { t1: "Alpha" }, // parent selected → branch visible
          branchValues: {},                  // branch value missing
        }),
      ],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(false);
  });
});

describe("CF-10 — Required branch visible and filled → ok: true", () => {
  it("passes when a required visible branch field has a value", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: true,
    });
    const spec = makeSpec({ branches: [branch] });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [
        makeLine({
          formFieldValues: { t1: "Alpha" },
          branchValues: { b1: "some value" },
        }),
      ],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-11 — Required branch but parent not selected → ok: true", () => {
  it("passes when required branch is not visible because parent has no selection", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: true,
    });
    const spec = makeSpec({ branches: [branch] });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [
        makeLine({
          formFieldValues: {}, // parent t1 not selected → branch not visible
          branchValues: {},
        }),
      ],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-12 — allowConditionalDropdown=false → branch check skipped", () => {
  it("skips branch validation entirely when conditional dropdowns are disabled", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: true,
    });
    const spec = makeSpec({ branches: [branch] });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      allowConditionalDropdown: false,
      lines: [
        makeLine({
          formFieldValues: { t1: "Alpha" },
          branchValues: {},
        }),
      ],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CF-13 to CF-16: safety guards and whitespace edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe("CF-13 — configLoaded=false → ok: false (safety guard)", () => {
  it("blocks submission when form config is still loading", () => {
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      configLoaded: false,
      lines: [makeLine()],
      categoryFieldSpecs: new Map(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/loading/i);
    }
  });
});

describe("CF-14 — Per-line field value '0' (non-empty) → ok: true", () => {
  it("treats string '0' as a valid non-empty value", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({ templateId: "t1", templateName: "Count", templateRequired: true })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ formFieldValues: { t1: "0" } })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-15 — Per-line field whitespace-only value → ok: false", () => {
  it("blocks when a required per-line field contains only whitespace", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({ templateId: "t1", templateName: "Project", templateRequired: true })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ formFieldValues: { t1: "   " } })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(false);
  });
});

describe("CF-16 — Shared field whitespace-only value → ok: false", () => {
  it("blocks when a required shared field contains only whitespace", () => {
    const spec = makeSpec({
      batchOnce: [makeAssignment({
        templateId: "s1",
        templateName: "Department",
        templateRequired: true,
        askOncePer: true,
      })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine()],
      categoryFieldSpecs: specs,
      batchFormFieldsByCategory: { Travel: { s1: "   " } },
    });
    expect(result.ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CF-17 to CF-20: assignment-mode splitting via splitAssignmentsByBatchMode
// ═════════════════════════════════════════════════════════════════════════════

describe("CF-17 — show_on_submit=false assignment excluded from validation", () => {
  it("does not block on a required field with show_on_submit=false", () => {
    const assignment = makeAssignment({
      templateId: "t1",
      templateName: "Hidden",
      templateRequired: true,
      showOnSubmit: false,
    });
    const split = splitAssignmentsByBatchMode([assignment]);
    // show_on_submit=false → filtered out before split → neither batchOnce nor perLine
    const spec = makeSpec({ batchOnce: split.batchOnce, perLine: split.perLine });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ formFieldValues: {} })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-18 — Assignment required=false overrides template required=true", () => {
  it("passes when assignment marks field optional even though template says required", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({
        templateId: "t1",
        templateName: "Project",
        templateRequired: true,
        assignmentRequired: false,
      })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ formFieldValues: {} })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(true);
  });
});

describe("CF-19 — ask_once_per_batch=null treated as perLine", () => {
  it("places null ask_once_per_batch assignment into perLine, not batchOnce", () => {
    const assignment = makeAssignment({
      templateId: "t1",
      templateName: "Field",
      askOncePer: null,
    });
    const split = splitAssignmentsByBatchMode([assignment]);
    expect(split.perLine).toHaveLength(1);
    expect(split.batchOnce).toHaveLength(0);
  });
});

describe("CF-20 — ask_once_per_batch=true treated as batchOnce", () => {
  it("places ask_once_per_batch=true assignment into batchOnce, not perLine", () => {
    const assignment = makeAssignment({
      templateId: "t1",
      templateName: "Shared Field",
      askOncePer: true,
    });
    const split = splitAssignmentsByBatchMode([assignment]);
    expect(split.batchOnce).toHaveLength(1);
    expect(split.perLine).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CF-21 to CF-22: error message content
// ═════════════════════════════════════════════════════════════════════════════

describe("CF-21 — Shared field error includes category name", () => {
  it("error message for missing shared field includes the category name", () => {
    const spec = makeSpec({
      batchOnce: [makeAssignment({
        templateId: "s1",
        templateName: "GL Code",
        templateRequired: true,
        askOncePer: true,
      })],
    });
    const specs = new Map([["Meals", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ category: "Meals" })],
      categoryFieldSpecs: specs,
      batchFormFieldsByCategory: { Meals: {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Meals");
      expect(result.message).toContain("GL Code");
    }
  });
});

describe("CF-22 — Per-line error message includes line label", () => {
  it("error message for missing per-line field includes the line title", () => {
    const spec = makeSpec({
      perLine: [makeAssignment({ templateId: "t1", templateName: "Invoice #", templateRequired: true })],
    });
    const specs = new Map([["Travel", spec]]);
    const result = validateBatchCustomFields({
      ...BASE_PARAMS,
      lines: [makeLine({ label: "Flight BOM-DEL", formFieldValues: {} })],
      categoryFieldSpecs: specs,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Flight BOM-DEL");
      expect(result.message).toContain("Invoice #");
    }
  });
});
