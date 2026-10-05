/**
 * Behavioral tests for the Detailed Expense worker's presentation-filter and
 * filename logic (owner QA fix pass, 2026-09-23).
 *
 * supabase/functions/run-report-export-job/expenseReports.ts has zero
 * imports of its own (no Deno-specific API used at module scope), so unlike
 * reportExportWorker.test.ts's source-contract (regex-on-text) tests, these
 * import the real functions and exercise their actual behavior.
 */
import { describe, expect, it } from "vitest";
import {
  matchesDetailedExpenseFilters,
  buildDetailedExpenseFilename,
  sanitizeFilenamePart,
  type BalanceTimelineRow,
} from "../../../supabase/functions/run-report-export-job/expenseReports";

function row(overrides: Partial<BalanceTimelineRow> = {}): BalanceTimelineRow {
  return {
    user_id: "u1",
    employee_name: "Sagar Patel",
    employee_code: "5540",
    event_id: "e1",
    event_type: "expense_deduction",
    event_label: "Expense Deduction",
    effective_date: "2026-06-15",
    amount_delta: -100,
    credit: null,
    debit: 100,
    opening_balance: 500,
    closing_balance: 400,
    note: "",
    actor_name: "",
    transaction_number: "00123",
    expense_id: "exp1",
    title: "Fuel",
    category: "Fuel",
    purpose: "Site visit",
    destination: "Ahmedabad",
    batch_ref: "",
    custom_fields: { "Project ID": "P101" },
    ...overrides,
  };
}

describe("matchesDetailedExpenseFilters", () => {
  it("keeps a matching expense row when a category filter is set", () => {
    expect(matchesDetailedExpenseFilters(row({ category: "Fuel" }), "Fuel", null)).toBe(true);
  });

  it("excludes a non-matching expense row when a category filter is set", () => {
    expect(matchesDetailedExpenseFilters(row({ category: "Travel" }), "Fuel", null)).toBe(false);
  });

  it("never excludes a non-expense balance event, even with a category filter set (ledger continuity)", () => {
    const creditRow = row({ event_type: "balance_credit", category: "" });
    expect(matchesDetailedExpenseFilters(creditRow, "Fuel", null)).toBe(true);
  });

  it("matches a custom-field filter against the expense row's own custom_fields map", () => {
    const r = row({ custom_fields: { "Project ID": "P101" } });
    expect(matchesDetailedExpenseFilters(r, null, { "Project ID": "P101" })).toBe(true);
    expect(matchesDetailedExpenseFilters(r, null, { "Project ID": "P999" })).toBe(false);
  });

  it("ignores a custom-field filter entry whose value is \"all\" or blank", () => {
    const r = row({ custom_fields: { "Project ID": "P101" } });
    expect(matchesDetailedExpenseFilters(r, null, { "Project ID": "all" })).toBe(true);
    expect(matchesDetailedExpenseFilters(r, null, { "Project ID": "" })).toBe(true);
  });

  it("with no filters at all, every row (expense or balance event) passes", () => {
    expect(matchesDetailedExpenseFilters(row(), null, null)).toBe(true);
    expect(matchesDetailedExpenseFilters(row(), null, {})).toBe(true);
  });

  it("requires ALL active custom-field filters to match (AND, not OR)", () => {
    const r = row({ custom_fields: { "Project ID": "P101", "Project Name": "Highway" } });
    expect(
      matchesDetailedExpenseFilters(r, null, { "Project ID": "P101", "Project Name": "Highway" }),
    ).toBe(true);
    expect(
      matchesDetailedExpenseFilters(r, null, { "Project ID": "P101", "Project Name": "Bridge" }),
    ).toBe(false);
  });
});

describe("sanitizeFilenamePart", () => {
  it("strips filesystem-unsafe characters", () => {
    expect(sanitizeFilenamePart('A/B\\C:D*E?F"G<H>I|J')).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("prevents path traversal", () => {
    expect(sanitizeFilenamePart("../../etc/passwd")).not.toContain("..");
  });

  it("collapses whitespace to hyphens", () => {
    expect(sanitizeFilenamePart("Sagar   Patel")).toBe("Sagar-Patel");
  });

  it("keeps non-ASCII/unicode names intact (e.g. Gujarati, Hindi script)", () => {
    expect(sanitizeFilenamePart("સાગર પટેલ")).toBe("સાગર-પટેલ");
    expect(sanitizeFilenamePart("सागर पटेल")).toBe("सागर-पटेल");
  });

  it("caps length and never returns empty", () => {
    expect(sanitizeFilenamePart("a".repeat(500)).length).toBeLessThanOrEqual(80);
    expect(sanitizeFilenamePart("")).toBe("Employee");
    expect(sanitizeFilenamePart("   ")).toBe("Employee");
  });
});

describe("buildDetailedExpenseFilename", () => {
  it("single employee: uses the employee's name + the actual requested date range, not today's date", () => {
    const name = buildDetailedExpenseFilename({
      singleUserId: "u1",
      employeeName: "Sagar Patel",
      employeeCode: "5540",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
    expect(name).toBe("Sagar-Patel_01-06-2026_to_30-06-2026.csv");
  });

  it("falls back to employee code when name is missing", () => {
    const name = buildDetailedExpenseFilename({
      singleUserId: "u1",
      employeeName: null,
      employeeCode: "5540",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(name).toBe("5540_01-01-2026_to_31-12-2026.csv");
  });

  it("all employees: uses All-Employees, never a person's name", () => {
    const name = buildDetailedExpenseFilename({
      singleUserId: null,
      employeeName: null,
      employeeCode: null,
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(name).toBe("All-Employees_01-01-2026_to_31-12-2026.csv");
  });

  it("uses all-time when no date range was requested", () => {
    const name = buildDetailedExpenseFilename({
      singleUserId: null,
      employeeName: null,
      employeeCode: null,
      dateFrom: null,
      dateTo: null,
    });
    expect(name).toBe("All-Employees_all-time.csv");
  });

  it("sanitizes an unsafe employee name so it cannot escape the reports directory", () => {
    const name = buildDetailedExpenseFilename({
      singleUserId: "u1",
      employeeName: "A/B Test",
      employeeCode: null,
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
  });
});
