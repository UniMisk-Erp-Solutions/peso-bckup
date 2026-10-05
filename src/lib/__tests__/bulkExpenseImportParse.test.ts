import { describe, expect, it } from "vitest";
import {
  parseDDMMYYYYToIso,
  parseBulkExpenseCsv,
  validateBulkRow,
  validateBulkRows,
  buildBulkExpenseCsvTemplate,
} from "@/lib/bulkExpenseImportParse";
import type { OrganizationExpenseFieldConfig } from "@/lib/orgExpenseFieldConfig";

describe("parseDDMMYYYYToIso", () => {
  it("parses a valid DD-MM-YYYY date", () => {
    expect(parseDDMMYYYYToIso("01-09-2026")).toBe("2026-09-01");
    expect(parseDDMMYYYYToIso("31-12-2026")).toBe("2026-12-31");
  });

  it("rejects out-of-range day/month", () => {
    expect(parseDDMMYYYYToIso("32-01-2026")).toBeNull();
    expect(parseDDMMYYYYToIso("01-13-2026")).toBeNull();
  });

  it("rejects malformed strings, including YYYY-MM-DD (never assume the other format)", () => {
    expect(parseDDMMYYYYToIso("2026-09-01")).toBeNull();
    expect(parseDDMMYYYYToIso("not a date")).toBeNull();
    expect(parseDDMMYYYYToIso("")).toBeNull();
  });

  it("never silently reinterprets an ambiguous day<=12 date the wrong way", () => {
    // 05-06-2026 must always mean 5 June, never 6 May -- this is exactly the
    // DateStyle-dependent ambiguity the DD-MM-YYYY convention exists to avoid.
    expect(parseDDMMYYYYToIso("05-06-2026")).toBe("2026-06-05");
  });
});

describe("parseBulkExpenseCsv", () => {
  it("parses a simple CSV with header and rows", () => {
    const csv = "employee_id,title,amount\nEMP001,Client visit,500\nEMP002,Site trip,750";
    const { headers, rows } = parseBulkExpenseCsv(csv);
    expect(headers).toEqual(["employee_id", "title", "amount"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].raw).toEqual({ employee_id: "EMP001", title: "Client visit", amount: "500" });
    expect(rows[1].rowIndex).toBe(1);
  });

  it("returns empty for an empty file", () => {
    expect(parseBulkExpenseCsv("")).toEqual({ headers: [], rows: [] });
  });

  it("handles a quoted field containing a comma", () => {
    const csv = 'employee_id,title\nEMP001,"Travel, and lodging"';
    const { rows } = parseBulkExpenseCsv(csv);
    expect(rows[0].raw.title).toBe("Travel, and lodging");
  });

  it("a quoted comma-formatted amount is preserved intact (not split)", () => {
    const csv = 'employee_id,amount\nEMP001,"1,000"';
    const { rows } = parseBulkExpenseCsv(csv);
    expect(rows[0].raw.amount).toBe("1,000");
    expect(rows[0].columnCountMismatch).toBeUndefined();
  });

  it("flags a row with an UNQUOTED comma-formatted amount via columnCountMismatch, instead of silently shifting columns", () => {
    // "1,000" written without quotes is indistinguishable, at the CSV level,
    // from two extra columns — the parser (correctly, per CSV syntax) reads
    // it as 10 cells for a 9-header row. Without the mismatch flag this would
    // silently become amount="1" (passes amount>0!) and purpose="000".
    const csv =
      "employee_id,email,title,destination,trip_start,trip_end,category,amount,purpose\n" +
      "EMP001,,Client visit,Site A,01-09-2026,01-09-2026,Travel,1,000,";
    const { rows } = parseBulkExpenseCsv(csv);
    expect(rows[0].columnCountMismatch).toEqual({ expected: 9, actual: 10 });
    // The raw amount cell is still "1" (unsafe if read directly) -- this is
    // exactly why validateBulkRow must check columnCountMismatch itself
    // rather than trusting that a plausible-looking amount is correct.
    expect(rows[0].raw.amount).toBe("1");
  });
});

function baseRow(overrides: Record<string, string> = {}) {
  return {
    rowIndex: 0,
    raw: {
      employee_id: "EMP001",
      email: "",
      title: "Client visit",
      destination: "Site A",
      trip_start: "01-09-2026",
      trip_end: "01-09-2026",
      category: "Travel",
      amount: "500",
      purpose: "",
      ...overrides,
    },
  };
}

describe("validateBulkRow — base field validation", () => {
  it("a fully valid row with no custom-field config passes", () => {
    const result = validateBulkRow(baseRow(), null);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.tripStartIso).toBe("2026-09-01");
    expect(result.amount).toBe(500);
  });

  it("a row with neither employee_id nor email is blocked, never guessed", () => {
    const result = validateBulkRow(baseRow({ employee_id: "", email: "" }), null);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("row has neither employee_id nor email");
  });

  it("a row identified by email alone (no employee_id) is valid", () => {
    const result = validateBulkRow(baseRow({ employee_id: "", email: "person@example.com" }), null);
    expect(result.ok).toBe(true);
    expect(result.email).toBe("person@example.com");
  });

  it("blank title/destination/category are each rejected", () => {
    expect(validateBulkRow(baseRow({ title: "" }), null).errors).toContain("title is required");
    expect(validateBulkRow(baseRow({ destination: "" }), null).errors).toContain("destination is required");
    expect(validateBulkRow(baseRow({ category: "" }), null).errors).toContain("category is required");
  });

  it("amount must be a positive number", () => {
    expect(validateBulkRow(baseRow({ amount: "0" }), null).ok).toBe(false);
    expect(validateBulkRow(baseRow({ amount: "-5" }), null).ok).toBe(false);
    expect(validateBulkRow(baseRow({ amount: "abc" }), null).ok).toBe(false);
    expect(validateBulkRow(baseRow({ amount: "" }), null).ok).toBe(false);
  });

  it("malformed dates are rejected with a clear message, not silently coerced", () => {
    const result = validateBulkRow(baseRow({ trip_start: "2026-09-01" }), null);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("trip_start must be DD-MM-YYYY");
  });

  it("1000 and 1000.50 are accepted as valid amounts", () => {
    expect(validateBulkRow(baseRow({ amount: "1000" }), null).amount).toBe(1000);
    expect(validateBulkRow(baseRow({ amount: "1000" }), null).ok).toBe(true);
    expect(validateBulkRow(baseRow({ amount: "1000.50" }), null).amount).toBe(1000.5);
    expect(validateBulkRow(baseRow({ amount: "1000.50" }), null).ok).toBe(true);
  });

  it("a quoted comma-formatted amount (e.g. \"1,000\") is rejected, never silently mis-parsed", () => {
    // This repo's CSV parser supports RFC4180 quoting, so "1,000" survives
    // intact as the single string "1,000" -- but amount parsing is raw
    // Number(), which has no thousands-separator support. Number("1,000")
    // is NaN, so the row is correctly rejected rather than silently becoming
    // amount=1 (stopping at the comma) or any other wrong value.
    const result = validateBulkRow(baseRow({ amount: "1,000" }), null);
    expect(result.ok).toBe(false);
    expect(result.amount).toBeNull();
    expect(result.errors).toContain("amount must be a number greater than zero");
  });

  it("a row-level column-count mismatch (unquoted comma in an earlier column) is rejected with a clear error, not a silently wrong amount", () => {
    const rowWithMismatch = {
      rowIndex: 0,
      raw: { ...baseRow().raw, amount: "1", purpose: "000" },
      columnCountMismatch: { expected: 9, actual: 10 },
    };
    const result = validateBulkRow(rowWithMismatch, null);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("columns but the header has");
  });
});

function makeConfig(overrides: Partial<OrganizationExpenseFieldConfig> = {}): OrganizationExpenseFieldConfig {
  return {
    baseFields: {} as OrganizationExpenseFieldConfig["baseFields"],
    categoriesById: new Map([["travel", "cat-1"]]),
    categoryFormFieldsByCategory: new Map(),
    optionBranches: [],
    ...overrides,
  };
}

describe("validateBulkRow — custom field validation against org config", () => {
  it("a required category-assigned field missing its column value is rejected", () => {
    const config = makeConfig({
      categoryFormFieldsByCategory: new Map([
        [
          "cat-1",
          [
            {
              required: true,
              template: { id: "tpl-1", name: "Client Name", field_type: "text", required: true },
            },
          ],
        ],
      ]),
    });
    const result = validateBulkRow(baseRow(), config);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Client Name");
    expect(result.errors[0]).toContain("required");
  });

  it("a filled required text field is accepted and included in customFieldValues", () => {
    const config = makeConfig({
      categoryFormFieldsByCategory: new Map([
        [
          "cat-1",
          [
            {
              required: true,
              template: { id: "tpl-1", name: "Client Name", field_type: "text", required: true },
            },
          ],
        ],
      ]),
    });
    const result = validateBulkRow(baseRow({ "Field:Client Name": "Acme Corp" }), config);
    expect(result.ok).toBe(true);
    expect(result.customFieldValues).toEqual([{ template_id: "tpl-1", field_value: "Acme Corp" }]);
  });

  it("a select-type field value not in the configured options is rejected", () => {
    const config = makeConfig({
      categoryFormFieldsByCategory: new Map([
        [
          "cat-1",
          [
            {
              required: true,
              template: { id: "tpl-1", name: "Project", field_type: "select", required: true, options: ["Alpha", "Beta"] },
            },
          ],
        ],
      ]),
    });
    const result = validateBulkRow(baseRow({ "Field:Project": "Gamma" }), config);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not a valid option");
  });

  it("a required conditional branch under the chosen parent value is validated", () => {
    const config = makeConfig({
      categoryFormFieldsByCategory: new Map([
        [
          "cat-1",
          [
            {
              required: true,
              template: { id: "tpl-1", name: "Project", field_type: "select", required: true, options: ["Alpha"] },
            },
          ],
        ],
      ]),
      optionBranches: [
        {
          id: "branch-1",
          parent_template_id: "tpl-1",
          parent_option_value: "Alpha",
          name: "Sub-project",
          field_type: "text",
          required: true,
          options: null,
          default_value: null,
        },
      ],
    });
    const missingBranch = validateBulkRow(baseRow({ "Field:Project": "Alpha" }), config);
    expect(missingBranch.ok).toBe(false);
    expect(missingBranch.errors.some((e) => e.includes("Sub-project"))).toBe(true);

    const filledBranch = validateBulkRow(
      baseRow({ "Field:Project": "Alpha", "Branch:Project::Sub-project": "Sub A" }),
      config,
    );
    expect(filledBranch.ok).toBe(true);
    expect(filledBranch.customFieldValues).toEqual([
      { template_id: "tpl-1", field_value: "Alpha" },
      { branch_field_id: "branch-1", field_value: "Sub A" },
    ]);
  });

  it("a branch under a DIFFERENT parent value is never applied to this row (wrong-project value stays absent)", () => {
    const config = makeConfig({
      categoryFormFieldsByCategory: new Map([
        [
          "cat-1",
          [{ required: false, template: { id: "tpl-1", name: "Project", field_type: "select", required: false, options: ["Alpha", "Beta"] } }],
        ],
      ]),
      optionBranches: [
        {
          id: "branch-alpha",
          parent_template_id: "tpl-1",
          parent_option_value: "Alpha",
          name: "Sub-project",
          field_type: "text",
          required: false,
          options: null,
          default_value: null,
        },
      ],
    });
    // Row chooses "Beta", so the Alpha-scoped branch must never be considered.
    const result = validateBulkRow(baseRow({ "Field:Project": "Beta", "Branch:Project::Sub-project": "should be ignored" }), config);
    expect(result.ok).toBe(true);
    expect(result.customFieldValues).toEqual([{ template_id: "tpl-1", field_value: "Beta" }]);
  });
});

describe("validateBulkRows", () => {
  it("validates each row independently, one failure does not affect others", () => {
    const rows = [baseRow({ title: "" }), baseRow()];
    rows[1].rowIndex = 1;
    const results = validateBulkRows(rows, null);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });
});

describe("buildBulkExpenseCsvTemplate", () => {
  it("includes the base headers and a reference section listing categories/required fields", () => {
    const config = makeConfig({
      categoryFormFieldsByCategory: new Map([
        ["cat-1", [{ required: true, template: { id: "tpl-1", name: "Client Name", field_type: "text", required: true } }]],
      ]),
    });
    const csv = buildBulkExpenseCsvTemplate(config);
    expect(csv).toContain("employee_id,email,title,destination,trip_start,trip_end,category,amount,purpose");
    expect(csv).toContain("travel");
    expect(csv).toContain("Client Name");
  });

  it("works with a null config (no reference section, no crash)", () => {
    expect(() => buildBulkExpenseCsvTemplate(null)).not.toThrow();
  });
});
