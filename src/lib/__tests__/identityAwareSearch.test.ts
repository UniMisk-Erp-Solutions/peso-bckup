/**
 * Tests for identity-policy integration in userMatchesManagementSearch
 * and expenseRowMatchesSearch.
 */
import { describe, it, expect } from "vitest";
import { userMatchesManagementSearch } from "@/lib/approvalHierarchy";
import { expenseRowMatchesSearch } from "@/lib/expenseListSearch";
import { resolveOrganizationIdentityPolicy } from "@/lib/organizationIdentityMode";

const emailOnly = resolveOrganizationIdentityPolicy(false, false);
const mixed = resolveOrganizationIdentityPolicy(true, false);
const eidOnly = resolveOrganizationIdentityPolicy(true, true);

const syntheticEmail = "emp.acme.EMP999.ab12cd@users.unimisk.com";

// ─── userMatchesManagementSearch ─────────────────────────────────────────────

describe("userMatchesManagementSearch — identity policy", () => {
  const user = {
    name: "Priya Mehta",
    email: "priya@example.com",
    role: "employee",
    employee_id: "PM100",
  };

  it("13. role display label still matches (no policy)", () => {
    expect(userMatchesManagementSearch(user, "employee")).toBe(true);
    expect(userMatchesManagementSearch(user, "Employee")).toBe(true);
  });

  it("14. name search works in all modes", () => {
    expect(userMatchesManagementSearch(user, "priya", null, emailOnly)).toBe(true);
    expect(userMatchesManagementSearch(user, "priya", null, mixed)).toBe(true);
    expect(userMatchesManagementSearch(user, "priya", null, eidOnly)).toBe(true);
  });

  it("email_only: email matched", () => {
    expect(userMatchesManagementSearch(user, "priya@example.com", null, emailOnly)).toBe(true);
  });

  it("employee_id_only: genuine email NOT matched", () => {
    expect(userMatchesManagementSearch(user, "priya@example.com", null, eidOnly)).toBe(false);
  });

  it("employee_id_only: employee_id matched", () => {
    expect(userMatchesManagementSearch(user, "PM100", null, eidOnly)).toBe(true);
  });

  it("mixed: email matched", () => {
    expect(userMatchesManagementSearch(user, "priya@example.com", null, mixed)).toBe(true);
  });

  it("mixed: employee_id matched", () => {
    expect(userMatchesManagementSearch(user, "PM100", null, mixed)).toBe(true);
  });

  it("15. empty query returns all rows", () => {
    expect(userMatchesManagementSearch(user, "", null, eidOnly)).toBe(true);
  });

  it("synthetic email: only ID fragment matched, not full email", () => {
    const userWithSynthetic = { ...user, employee_id: null, email: syntheticEmail };
    // The full synthetic email must NOT match
    expect(userMatchesManagementSearch(userWithSynthetic, syntheticEmail, null, eidOnly)).toBe(
      false,
    );
    // But the extracted ID fragment (EMP999) MUST match
    expect(userMatchesManagementSearch(userWithSynthetic, "EMP999", null, eidOnly)).toBe(true);
  });

  it("no policy (legacy): email always searched", () => {
    expect(userMatchesManagementSearch(user, "priya@example.com")).toBe(true);
  });

  it("17. no cross-mode policy leakage — eidOnly policy doesn't match email", () => {
    const result = userMatchesManagementSearch(user, "priya@example.com", null, eidOnly);
    expect(result).toBe(false);
    // Re-confirm it still matches with emailOnly
    expect(userMatchesManagementSearch(user, "priya@example.com", null, emailOnly)).toBe(true);
  });
});

// ─── expenseRowMatchesSearch ──────────────────────────────────────────────────

describe("expenseRowMatchesSearch — identity options", () => {
  const row = {
    title: "Travel to Ahmedabad",
    destination: "Ahmedabad",
    user_name: "Suresh Kumar",
    user_email: "suresh@example.com",
    user_employee_id: "SK201",
    transaction_number: "TXN-2024-001",
    custom_fields: { Project: "AHM-Gateway" },
  };

  const eidOpts = {
    includeEmail: false,
    includeEmployeeId: true,
    allowSyntheticEmployeeIdFallback: true,
  };
  const emailOnlyOpts = {
    includeEmail: true,
    includeEmployeeId: false,
    allowSyntheticEmployeeIdFallback: false,
  };
  const mixedOpts = {
    includeEmail: true,
    includeEmployeeId: true,
    allowSyntheticEmployeeIdFallback: false,
  };

  it("63. All Expenses still searches transaction number", () => {
    expect(expenseRowMatchesSearch(row, "TXN-2024-001", eidOpts)).toBe(true);
  });

  it("64. All Expenses still searches custom-field values", () => {
    expect(expenseRowMatchesSearch(row, "AHM-Gateway", eidOpts)).toBe(true);
  });

  it("62. All Expenses still searches Employee ID in eidOnly mode", () => {
    expect(expenseRowMatchesSearch(row, "SK201", eidOpts)).toBe(true);
  });

  it("61. All Expenses eid-only: email NOT matched", () => {
    expect(expenseRowMatchesSearch(row, "suresh@example.com", eidOpts)).toBe(false);
  });

  it("email-only mode: email matched", () => {
    expect(expenseRowMatchesSearch(row, "suresh@example.com", emailOnlyOpts)).toBe(true);
  });

  it("mixed mode: both email and employee_id matched", () => {
    expect(expenseRowMatchesSearch(row, "suresh@example.com", mixedOpts)).toBe(true);
    expect(expenseRowMatchesSearch(row, "SK201", mixedOpts)).toBe(true);
  });

  it("no options (legacy default): all fields searched", () => {
    expect(expenseRowMatchesSearch(row, "suresh@example.com")).toBe(true);
    expect(expenseRowMatchesSearch(row, "SK201")).toBe(true);
  });

  it("15. empty query returns all rows", () => {
    expect(expenseRowMatchesSearch(row, "", eidOpts)).toBe(true);
    expect(expenseRowMatchesSearch(row, "  ", eidOpts)).toBe(true);
  });

  it("multi-word query: all words must match", () => {
    expect(expenseRowMatchesSearch(row, "suresh ahmedabad", eidOpts)).toBe(true);
    expect(expenseRowMatchesSearch(row, "suresh notfound", eidOpts)).toBe(false);
  });

  it("10. synthetic email: ID fragment matched, full email not", () => {
    const rowWithSynthetic = {
      ...row,
      user_employee_id: null,
      user_email: syntheticEmail,
    };
    const opts = { includeEmail: false, includeEmployeeId: true, allowSyntheticEmployeeIdFallback: true };
    // Full email must NOT match
    expect(expenseRowMatchesSearch(rowWithSynthetic, syntheticEmail, opts)).toBe(false);
    // Parsed ID fragment must match
    expect(expenseRowMatchesSearch(rowWithSynthetic, "EMP999", opts)).toBe(true);
  });
});
