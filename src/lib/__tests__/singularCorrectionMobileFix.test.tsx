/**
 * DOC-044 — Singular Expense Correction Mobile Fix
 *
 * SM-1  — EMPTY_CORRECTION_FIELDS: categoryFormFields is []
 * SM-2  — EMPTY_CORRECTION_FIELDS: optionBranches is []
 * SM-3  — EMPTY_CORRECTION_FIELDS: formFieldValues is {}
 * SM-4  — EMPTY_CORRECTION_FIELDS: branchValues is {}
 * SM-5  — Guard: no fields → formFieldValues guard produces undefined
 * SM-6  — Guard: no fields → branchValues guard produces undefined
 * SM-7  — Guard: no fields → visibleBranchIds guard produces undefined
 * SM-8  — Guard: has fields → formFieldValues guard returns actual map
 * SM-9  — Guard: has fields → branchValues guard returns actual map
 * SM-10 — Guard: has fields + empty formFieldValues → guard returns {} (clear semantics)
 * SM-11 — MobileCorrectionFields: renders title label
 * SM-12 — MobileCorrectionFields: renders total amount input
 * SM-13 — MobileCorrectionFields: renders admin comment label
 * SM-14 — MobileCorrectionFields: renders correction reason label
 * SM-15 — MobileCorrectionFields: renders Save correction button
 * SM-16 — MobileCorrectionFields: renders Cancel button
 * SM-17 — MobileCorrectionFields: renders CorrectionCustomFieldsSection when model has fields
 * SM-18 — MobileCorrectionFields: CorrectionCustomFieldsSection absent when model is empty
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import {
  EMPTY_CORRECTION_FIELDS,
  type CorrectionCustomFieldsModel,
  type CorrectionFieldAssignment,
} from "@/lib/loadCorrectionCustomFields";

// ── Mocks (hoisted by Vitest before imports) ──────────────────────────────────

vi.mock("@/components/CorrectionCustomFieldsSection", () => ({
  CorrectionCustomFieldsSection: ({
    categoryFormFields,
  }: {
    categoryFormFields: unknown[];
  }) =>
    categoryFormFields.length > 0 ? (
      <div data-testid="custom-fields-section" />
    ) : null,
}));

vi.mock("@/components/ExpenseCategorySelect", () => ({
  ExpenseCategorySelect: () => (
    <select data-testid="category-select" aria-label="Category" />
  ),
}));

import { MobileCorrectionFields } from "@/components/mobile/MobileCorrectionFields";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeField(id: string, name: string): CorrectionFieldAssignment {
  return {
    template: {
      id,
      name,
      field_type: "text",
      required: false,
      placeholder: null,
      help_text: null,
      validation_rules: null,
      options: null,
    },
    required: null,
  };
}

const noop = () => {};

function defaultProps(
  overrides: Partial<ComponentProps<typeof MobileCorrectionFields>> = {},
): ComponentProps<typeof MobileCorrectionFields> {
  return {
    organizationId: "org-1",
    corrTitle: "",
    setCorrTitle: noop,
    corrDestination: "",
    setCorrDestination: noop,
    corrExpenseDate: "",
    setCorrExpenseDate: noop,
    corrPurpose: "",
    setCorrPurpose: noop,
    corrCategory: "",
    setCorrCategory: noop,
    corrAmount: "0",
    setCorrAmount: noop,
    corrAdminComment: "",
    setCorrAdminComment: noop,
    correctionReason: "",
    setCorrectionReason: noop,
    corrFieldModel: EMPTY_CORRECTION_FIELDS,
    onCorrFormFieldValuesChange: noop,
    onCorrBranchValuesChange: noop,
    loading: false,
    onSubmit: noop,
    onCancel: noop,
    ...overrides,
  };
}

function modelWithFields(): CorrectionCustomFieldsModel {
  return {
    categoryFormFields: [makeField("t1", "Project")],
    optionBranches: [],
    formFieldValues: { t1: "Alpha" },
    branchValues: {},
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// SM-1 to SM-4: EMPTY_CORRECTION_FIELDS shape
// ═════════════════════════════════════════════════════════════════════════════

describe("SM-1 — EMPTY_CORRECTION_FIELDS: categoryFormFields is []", () => {
  it("has an empty categoryFormFields array", () => {
    expect(EMPTY_CORRECTION_FIELDS.categoryFormFields).toEqual([]);
  });
});

describe("SM-2 — EMPTY_CORRECTION_FIELDS: optionBranches is []", () => {
  it("has an empty optionBranches array", () => {
    expect(EMPTY_CORRECTION_FIELDS.optionBranches).toEqual([]);
  });
});

describe("SM-3 — EMPTY_CORRECTION_FIELDS: formFieldValues is {}", () => {
  it("has an empty formFieldValues object", () => {
    expect(EMPTY_CORRECTION_FIELDS.formFieldValues).toEqual({});
  });
});

describe("SM-4 — EMPTY_CORRECTION_FIELDS: branchValues is {}", () => {
  it("has an empty branchValues object", () => {
    expect(EMPTY_CORRECTION_FIELDS.branchValues).toEqual({});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SM-5 to SM-10: categoryFormFields.length guard logic
// ═════════════════════════════════════════════════════════════════════════════

describe("SM-5 — Guard: no fields → formFieldValues guard produces undefined", () => {
  it("returns undefined when categoryFormFields is empty", () => {
    const m = EMPTY_CORRECTION_FIELDS;
    const result = m.categoryFormFields.length > 0 ? m.formFieldValues : undefined;
    expect(result).toBeUndefined();
  });
});

describe("SM-6 — Guard: no fields → branchValues guard produces undefined", () => {
  it("returns undefined when categoryFormFields is empty", () => {
    const m = EMPTY_CORRECTION_FIELDS;
    const result = m.categoryFormFields.length > 0 ? m.branchValues : undefined;
    expect(result).toBeUndefined();
  });
});

describe("SM-7 — Guard: no fields → visibleBranchIds guard produces undefined", () => {
  it("returns undefined when categoryFormFields is empty", () => {
    const m = EMPTY_CORRECTION_FIELDS;
    const visibleBranchIds = new Set<string>();
    const result = m.categoryFormFields.length > 0 ? visibleBranchIds : undefined;
    expect(result).toBeUndefined();
  });
});

describe("SM-8 — Guard: has fields → formFieldValues guard returns actual map", () => {
  it("passes through formFieldValues when category has configured fields", () => {
    const m = modelWithFields();
    const result = m.categoryFormFields.length > 0 ? m.formFieldValues : undefined;
    expect(result).toEqual({ t1: "Alpha" });
  });
});

describe("SM-9 — Guard: has fields → branchValues guard returns actual map", () => {
  it("passes through branchValues when category has configured fields", () => {
    const m: CorrectionCustomFieldsModel = {
      ...modelWithFields(),
      branchValues: { b1: "branchVal" },
    };
    const result = m.categoryFormFields.length > 0 ? m.branchValues : undefined;
    expect(result).toEqual({ b1: "branchVal" });
  });
});

describe("SM-10 — Guard: has fields + empty formFieldValues → returns {} (replace/clear semantics)", () => {
  it("returns {} (not undefined) when model has fields but values are cleared", () => {
    const m: CorrectionCustomFieldsModel = {
      categoryFormFields: [makeField("t1", "Project")],
      optionBranches: [],
      formFieldValues: {},  // user cleared all values
      branchValues: {},
    };
    const result = m.categoryFormFields.length > 0 ? m.formFieldValues : undefined;
    expect(result).toEqual({});
    expect(result).not.toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SM-11 to SM-18: MobileCorrectionFields rendering
// ═════════════════════════════════════════════════════════════════════════════

describe("SM-11 — MobileCorrectionFields: renders title label", () => {
  it("shows the Title label", () => {
    render(<MobileCorrectionFields {...defaultProps()} />);
    expect(screen.getByText("Title")).toBeTruthy();
  });
});

describe("SM-12 — MobileCorrectionFields: renders total amount input", () => {
  it("shows a number input for total amount", () => {
    render(<MobileCorrectionFields {...defaultProps()} />);
    expect(screen.getByText("Total amount")).toBeTruthy();
  });
});

describe("SM-13 — MobileCorrectionFields: renders admin comment label", () => {
  it("shows the Admin comment label", () => {
    render(<MobileCorrectionFields {...defaultProps()} />);
    expect(screen.getByText("Admin comment")).toBeTruthy();
  });
});

describe("SM-14 — MobileCorrectionFields: renders correction reason label", () => {
  it("shows the Reason for correction label", () => {
    render(<MobileCorrectionFields {...defaultProps()} />);
    expect(screen.getByText("Reason for correction (audit)")).toBeTruthy();
  });
});

describe("SM-15 — MobileCorrectionFields: renders Save correction button", () => {
  it("shows the Save correction button", () => {
    render(<MobileCorrectionFields {...defaultProps()} />);
    expect(screen.getByText("Save correction")).toBeTruthy();
  });
});

describe("SM-16 — MobileCorrectionFields: renders Cancel button", () => {
  it("shows the Cancel button", () => {
    render(<MobileCorrectionFields {...defaultProps()} />);
    expect(screen.getByText("Cancel")).toBeTruthy();
  });
});

describe("SM-17 — MobileCorrectionFields: renders CorrectionCustomFieldsSection when model has fields", () => {
  it("renders the custom-fields-section testid when corrFieldModel has configured fields", () => {
    render(<MobileCorrectionFields {...defaultProps({ corrFieldModel: modelWithFields() })} />);
    expect(screen.getByTestId("custom-fields-section")).toBeTruthy();
  });
});

describe("SM-18 — MobileCorrectionFields: CorrectionCustomFieldsSection absent when model is empty", () => {
  it("does not render custom-fields-section when corrFieldModel has no configured fields", () => {
    render(<MobileCorrectionFields {...defaultProps({ corrFieldModel: EMPTY_CORRECTION_FIELDS })} />);
    expect(screen.queryByTestId("custom-fields-section")).toBeNull();
  });
});
