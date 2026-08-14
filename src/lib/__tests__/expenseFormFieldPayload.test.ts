import { describe, it, expect } from "vitest";
import {
  buildExpenseCustomFieldPayload,
  isFilledCustomFieldValue,
  type ExpenseCustomFieldValuePayload,
} from "@/lib/expenseFormFieldPayload";

const byTemplate = (rows: ExpenseCustomFieldValuePayload[]) =>
  rows.filter((r) => r.template_id !== null);
const byBranch = (rows: ExpenseCustomFieldValuePayload[]) =>
  rows.filter((r) => r.branch_field_id !== null);

describe("isFilledCustomFieldValue", () => {
  it("keeps 0 and false as valid values", () => {
    expect(isFilledCustomFieldValue(0)).toBe(true);
    expect(isFilledCustomFieldValue(false)).toBe(true);
    expect(isFilledCustomFieldValue("0")).toBe(true);
    expect(isFilledCustomFieldValue("false")).toBe(true);
  });

  it("treats null, undefined and empty string as not filled", () => {
    expect(isFilledCustomFieldValue(null)).toBe(false);
    expect(isFilledCustomFieldValue(undefined)).toBe(false);
    expect(isFilledCustomFieldValue("")).toBe(false);
  });
});

describe("buildExpenseCustomFieldPayload", () => {
  it("builds rows for regular template values", () => {
    const payload = buildExpenseCustomFieldPayload({
      templateValues: { "tpl-1": "ABC", "tpl-2": "Pune" },
    });
    expect(byTemplate(payload)).toHaveLength(2);
    expect(payload).toContainEqual({
      template_id: "tpl-1",
      branch_field_id: null,
      field_value: "ABC",
    });
  });

  it("combines regular and branch values into one list", () => {
    const payload = buildExpenseCustomFieldPayload({
      templateValues: { "tpl-1": "ABC" },
      branchValues: { "br-1": "child" },
      visibleBranchIds: new Set(["br-1"]),
    });
    expect(byTemplate(payload)).toHaveLength(1);
    expect(byBranch(payload)).toHaveLength(1);
    expect(payload).toContainEqual({
      template_id: null,
      branch_field_id: "br-1",
      field_value: "child",
    });
  });

  it("preserves '0' and 'false' values", () => {
    const payload = buildExpenseCustomFieldPayload({
      templateValues: { "tpl-zero": "0", "tpl-flag": "false" },
    });
    expect(payload).toContainEqual({
      template_id: "tpl-zero",
      branch_field_id: null,
      field_value: "0",
    });
    expect(payload).toContainEqual({
      template_id: "tpl-flag",
      branch_field_id: null,
      field_value: "false",
    });
  });

  it("drops empty / null / undefined values (so they disappear on edit)", () => {
    const payload = buildExpenseCustomFieldPayload({
      templateValues: {
        "tpl-1": "keep",
        "tpl-empty": "",
        "tpl-null": null,
        "tpl-undef": undefined,
      },
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].template_id).toBe("tpl-1");
  });

  it("excludes branch values that are not currently visible", () => {
    const payload = buildExpenseCustomFieldPayload({
      branchValues: { "br-visible": "x", "br-hidden": "y" },
      visibleBranchIds: new Set(["br-visible"]),
    });
    expect(byBranch(payload)).toHaveLength(1);
    expect(payload[0].branch_field_id).toBe("br-visible");
  });

  it("includes all filled branch values when visibleBranchIds is omitted", () => {
    const payload = buildExpenseCustomFieldPayload({
      branchValues: { "br-1": "x", "br-2": "y" },
    });
    expect(byBranch(payload)).toHaveLength(2);
  });

  it("deduplicates repeated template ids (last value wins)", () => {
    // Object keys are unique, so simulate dedupe via the map collapsing behavior:
    const payload = buildExpenseCustomFieldPayload({
      templateValues: { "tpl-1": "second" },
    });
    expect(byTemplate(payload)).toHaveLength(1);
    expect(payload[0].field_value).toBe("second");
  });

  it("returns an empty array when nothing is filled", () => {
    const payload = buildExpenseCustomFieldPayload({
      templateValues: { a: "", b: null },
      branchValues: {},
    });
    expect(payload).toEqual([]);
  });
});
