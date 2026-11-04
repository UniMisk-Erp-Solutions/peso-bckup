import { describe, expect, it } from "vitest";
import { describePwtJob, generatePairingCode, isPwtActive, sha256Hex, toPwtReportType, type PwtJob } from "../pwtSync";

const job = (over: Partial<PwtJob> = {}): PwtJob => ({
  id: "j", report_type: "detailed_expense", status: "queued", tally_company: "C", created_at: "2026-10-16T00:00:00Z",
  completed_at: null, row_count: 0, posted_count: 0, voucher_count: 0, issue_count: 0, blocking_count: 0, error: null,
  progress_current: 0, progress_total: null, issues: [], ...over,
});

describe("pwt browser client", () => {
  it("maps the panel's report names", () => {
    expect(toPwtReportType(undefined)).toBe("daily_project");
    expect(toPwtReportType("daily_project_report")).toBe("daily_project");
    expect(toPwtReportType("claim_approval")).toBe("claim_approval");
    expect(() => toPwtReportType("nope")).toThrow();
  });

  it("only queued/preparing/delivering are active", () => {
    expect(["queued", "preparing", "delivering"].every((s) => isPwtActive(s as never))).toBe(true);
    expect(["completed", "needs_attention", "failed", "cancelled"].some((s) => isPwtActive(s as never))).toBe(false);
  });

  it("explains each state in plain language and surfaces blocking rows", () => {
    expect(describePwtJob(job({ status: "preparing", progress_current: 5, progress_total: 10 }))).toContain("5 of 10");
    expect(describePwtJob(job({ status: "delivering" }))).toMatch(/connector/i);
    expect(describePwtJob(job({ status: "completed", voucher_count: 2, posted_count: 9, row_count: 9 }))).toMatch(/Verified in TallyPrime/);
    const na = describePwtJob(job({
      status: "needs_attention", blocking_count: 3,
      issues: [{ code: "UNMAPPED_EXPENSE_TYPE", sourceId: "x", detail: 'expense type "other" has no ledger mapping', blocking: true }],
    }));
    expect(na).toContain("3 row(s)");
    expect(na).toContain("no ledger mapping");
  });

  it("pairing codes are 12 unambiguous chars and hash deterministically", async () => {
    const c = generatePairingCode();
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

import { buildPwtParameters, DEFAULT_PWT_CATEGORIES, unmappedTypesFromJobs, validatePwtConfig } from "../pwtSync";

describe("mapping settings", () => {
  it("defaults are valid", () => {
    expect(validatePwtConfig({ categories: DEFAULT_PWT_CATEGORIES, voucherPrefix: "PESO" })).toBe("");
  });
  it("explains problems before saving", () => {
    expect(validatePwtConfig({ categories: [] })).toMatch(/at least one/);
    expect(validatePwtConfig({ categories: [{ expenseType: "A", expenseLedger: "", serial: 1 }] })).toMatch(/ledger/);
    expect(validatePwtConfig({ categories: [{ expenseType: "A", expenseLedger: "L", serial: 0 }] })).toMatch(/1 to 99/);
    expect(validatePwtConfig({ categories: [{ expenseType: "A", expenseLedger: "L", serial: 1 }, { expenseType: "B", expenseLedger: "L", serial: 1 }] })).toMatch(/twice/);
    expect(validatePwtConfig({ categories: [{ expenseType: "A", expenseLedger: "L", serial: 1 }, { expenseType: " a", expenseLedger: "L", serial: 2 }] })).toMatch(/twice/);
    expect(validatePwtConfig({ categories: DEFAULT_PWT_CATEGORIES, voucherPrefix: "A/B" })).toMatch(/prefix/);
  });
  it("finds expense types that still need a mapping", () => {
    const j = { status: "needs_attention", issues: [
      { code: "UNMAPPED_EXPENSE_TYPE", sourceId: "x", blocking: true, detail: 'expense type "Parking" has no ledger mapping' },
      { code: "UNMAPPED_EXPENSE_TYPE", sourceId: "y", blocking: true, detail: 'expense type "Parking" has no ledger mapping' },
      { code: "BAD_DATE", sourceId: "z", blocking: true, detail: "x" },
    ] } as never;
    expect(unmappedTypesFromJobs([j])).toEqual(["Parking"]);
  });
});

describe("delivering with an offline connector", () => {
  it("tells the user why it is waiting", () => {
    const j = { status: "delivering", issues: [], progress_current: 0, progress_total: null } as never;
    expect(describePwtJob(j, false)).toMatch(/offline/i);
    expect(describePwtJob(j, true)).toMatch(/delivers it to TallyPrime/);
    expect(describePwtJob(j)).toMatch(/delivers it to TallyPrime/);
  });
});

describe("sync parameters", () => {
  it("passes only the filters in use, in the names the worker reads", () => {
    expect(buildPwtParameters({ reportType: "claim_approval", category: "all", userId: "all", engineerStatus: "verified", dateFrom: "2026-08-01", dateTo: "2026-08-31", customFieldFilters: { A: "all", B: "x" }, selectedYear: "2026", selectedMonth: "all" }))
      .toEqual({ engineer_status: "verified", date_from: "2026-08-01", date_to: "2026-08-31", custom_field_filters: { B: "x" }, year: "2026" });
    expect(buildPwtParameters({ reportType: "daily_project", userIds: ["u1", "u2"] })).toEqual({ user_ids: ["u1", "u2"] });
  });
});

import { friendlyTallyError } from "../pwtSync";
describe("friendlyTallyError", () => {
  it("explains Tally's 'Voucher date is missing' as a financial-year problem", () => {
    const m = friendlyTallyError("Tally rejected vouchers: Voucher date is missing for: 'Journal' voucher PESO/06/05. Verify the data");
    expect(m).toContain("PESO/06/05");
    expect(m).toMatch(/financial year/);
    expect(m).toContain("Alt+F3");
  });
  it("shows what the connector read when the books already cover the date", () => {
    const m = friendlyTallyError("Tally rejected vouchers: Voucher date is missing for: 'Journal' voucher PESO/06/05 | Connector note: company dates read: Financial year from 1-Jan-2026, Books from 1-Jan-2026; earliest voucher 30-Jun-2026 (inside the books, so Tally refused this date for another reason).");
    expect(m).toContain("although the company's books cover it");
    expect(m).toContain("Financial year from 1-Jan-2026");
    expect(m).not.toContain("outside this company's financial year");
  });
  it("leaves other messages unchanged", () => {
    expect(friendlyTallyError("Something else")).toBe("Something else");
    expect(friendlyTallyError(null)).toBeNull();
  });
});
