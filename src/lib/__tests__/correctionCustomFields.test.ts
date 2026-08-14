/**
 * DOC-044 — Correction Dialog Custom Fields Validation
 *
 * CC-1  — Required template field empty → ok: false, message names field
 * CC-2  — Required template field filled → ok: true
 * CC-3  — Optional template field (required=false) empty → ok: true
 * CC-4  — Assignment required=false overrides template required=true → ok: true
 * CC-5  — Assignment required=null falls back to template required=true → ok: false
 * CC-6  — Assignment required=null falls back to template required=false → ok: true
 * CC-7  — Assignment required=true overrides template required=false → ok: false
 * CC-8  — Multiple fields; first required field fails → ok: false, message names it
 * CC-9  — Required branch visible (parent selected "Alpha") but empty → ok: false
 * CC-10 — Required branch visible and filled → ok: true
 * CC-11 — Required branch not visible (parent not selected) → ok: true
 * CC-12 — Optional branch visible but empty → ok: true
 * CC-13 — Required field value "0" (non-empty numeric string) → ok: true
 * CC-14 — Required field value "false" (non-empty bool string) → ok: true
 * CC-15 — Required field value whitespace-only → ok: false
 * CC-16 — Required field value "   " (multiple spaces) → ok: false
 * CC-17 — No fields configured at all → ok: true
 * CC-18 — Fields with no option branches → branch check skipped → ok: true even if branch values empty
 */

import { describe, it, expect } from "vitest";
import {
  validateCorrectionCustomFields,
  type CorrectionFieldAssignment,
} from "@/lib/loadCorrectionCustomFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeField(opts: {
  id: string;
  name: string;
  templateRequired?: boolean;
  assignmentRequired?: boolean | null;
  fieldType?: string;
}): CorrectionFieldAssignment {
  return {
    template: {
      id: opts.id,
      name: opts.name,
      field_type: opts.fieldType ?? "text",
      required: opts.templateRequired ?? false,
      placeholder: null,
      help_text: null,
      validation_rules: null,
      options: null,
    },
    required: opts.assignmentRequired !== undefined ? opts.assignmentRequired : null,
  };
}

function makeBranch(opts: {
  id: string;
  parentTemplateId: string;
  parentOptionValue: string;
  required?: boolean;
}): OptionBranchDefinition {
  return {
    id: opts.id,
    organization_id: "org-1",
    parent_template_id: opts.parentTemplateId,
    parent_option_value: opts.parentOptionValue,
    parent_branch_id: null,
    field_key: opts.id,
    name: `Branch ${opts.id}`,
    field_type: "text",
    required: opts.required ?? false,
    placeholder: null,
    help_text: null,
    default_value: null,
    validation_rules: null,
    options: null,
    display_order: 0,
  };
}

const ALLOW_NESTED = false;

// ═════════════════════════════════════════════════════════════════════════════
// CC-1 to CC-8: template field required/optional combinations
// ═════════════════════════════════════════════════════════════════════════════

describe("CC-1 — Required template field empty → ok: false", () => {
  it("blocks when a required template field has no value", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Project", templateRequired: true })],
      {},
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Project");
  });
});

describe("CC-2 — Required template field filled → ok: true", () => {
  it("passes when a required template field has a value", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Project", templateRequired: true })],
      { t1: "Alpha" },
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-3 — Optional template field empty → ok: true", () => {
  it("passes when an optional template field is empty", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Note", templateRequired: false })],
      {},
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-4 — Assignment required=false overrides template required=true → ok: true", () => {
  it("passes when assignment marks field optional even though template requires it", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Project", templateRequired: true, assignmentRequired: false })],
      {},
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-5 — Assignment required=null falls back to template required=true → ok: false", () => {
  it("blocks when assignment required is null and template required is true", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Cost Center", templateRequired: true, assignmentRequired: null })],
      {},
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(false);
  });
});

describe("CC-6 — Assignment required=null falls back to template required=false → ok: true", () => {
  it("passes when assignment required is null and template required is false", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Notes", templateRequired: false, assignmentRequired: null })],
      {},
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-7 — Assignment required=true overrides template required=false → ok: false", () => {
  it("blocks when assignment forces required even though template doesn't", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Invoice #", templateRequired: false, assignmentRequired: true })],
      {},
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Invoice #");
  });
});

describe("CC-8 — Multiple fields; first required field fails → ok: false, message names it", () => {
  it("reports the first required field that fails", () => {
    const fields = [
      makeField({ id: "t1", name: "Project", templateRequired: true }),
      makeField({ id: "t2", name: "Department", templateRequired: true }),
    ];
    const result = validateCorrectionCustomFields(fields, { t2: "Eng" }, [], {}, ALLOW_NESTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Project");
      expect(result.message).not.toContain("Department");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CC-9 to CC-12: branch field validation
// ═════════════════════════════════════════════════════════════════════════════

describe("CC-9 — Required branch visible (parent selected) but empty → ok: false", () => {
  it("blocks when a required branch is visible but has no value", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: true,
    });
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Type", fieldType: "select" })],
      { t1: "Alpha" },
      [branch],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Branch b1");
  });
});

describe("CC-10 — Required branch visible and filled → ok: true", () => {
  it("passes when a required visible branch field has a value", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: true,
    });
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Type", fieldType: "select" })],
      { t1: "Alpha" },
      [branch],
      { b1: "some value" },
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-11 — Required branch not visible (parent not selected) → ok: true", () => {
  it("passes when required branch is invisible because parent has no selection", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: true,
    });
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Type", fieldType: "select" })],
      {},        // parent t1 not selected → branch not visible
      [branch],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-12 — Optional branch visible but empty → ok: true", () => {
  it("passes when an optional visible branch field has no value", () => {
    const branch = makeBranch({
      id: "b1",
      parentTemplateId: "t1",
      parentOptionValue: "Alpha",
      required: false,
    });
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Type", fieldType: "select" })],
      { t1: "Alpha" },
      [branch],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CC-13 to CC-16: whitespace / zero / bool edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe("CC-13 — Required field value '0' (non-empty numeric string) → ok: true", () => {
  it("treats string '0' as a valid non-empty value", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Count", templateRequired: true })],
      { t1: "0" },
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-14 — Required field value 'false' (non-empty bool string) → ok: true", () => {
  it("treats string 'false' as a valid non-empty value", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Active", templateRequired: true, fieldType: "checkbox" })],
      { t1: "false" },
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});

describe("CC-15 — Required field value whitespace-only → ok: false", () => {
  it("blocks when a required field contains only whitespace", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Project", templateRequired: true })],
      { t1: " " },
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(false);
  });
});

describe("CC-16 — Required field value multiple spaces → ok: false", () => {
  it("blocks when a required field contains only multiple spaces", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Project", templateRequired: true })],
      { t1: "   " },
      [],
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CC-17 to CC-18: empty / no-branch scenarios
// ═════════════════════════════════════════════════════════════════════════════

describe("CC-17 — No fields configured at all → ok: true", () => {
  it("passes when there are no custom fields to validate", () => {
    const result = validateCorrectionCustomFields([], {}, [], {}, ALLOW_NESTED);
    expect(result.ok).toBe(true);
  });
});

describe("CC-18 — No option branches → branch check skipped → ok: true", () => {
  it("skips branch validation entirely when optionBranches is empty", () => {
    const result = validateCorrectionCustomFields(
      [makeField({ id: "t1", name: "Type", fieldType: "select", templateRequired: false })],
      {},
      [],   // no branches
      {},
      ALLOW_NESTED,
    );
    expect(result.ok).toBe(true);
  });
});
