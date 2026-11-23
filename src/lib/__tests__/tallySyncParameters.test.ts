import { describe, expect, it } from "vitest";
import { buildTallySyncParameters } from "@/lib/tallySyncParameters";
import { computeDetailedExpenseDateRange } from "@/lib/detailedExpenseReportFilters";

describe("buildTallySyncParameters", () => {
  it("Claim Verification no-filter context has no user/category/engineer keys", () => {
    const p = buildTallySyncParameters({
      reportType: "claim_verification",
      category: "all",
      userId: "all",
      engineerStatus: "all",
    });
    expect(p.user_id).toBeUndefined();
    expect(p.category).toBeUndefined();
    expect(p.engineer_status).toBeUndefined();
    expect(p.context_version).toBe(1);
  });

  it("Claim Approval no-filter context records default HO UI value and export_parity", () => {
    const p = buildTallySyncParameters({
      reportType: "claim_approval",
      category: "all",
      userId: "all",
      engineerStatus: "all",
      hoStatus: "approved",
    });
    expect(p.user_id).toBeUndefined();
    expect(p.ho_status).toBe("approved");
    expect(p.export_parity).toMatchObject({
      custom_field_filters_in_report_export: false,
      claim_approval_engineer_status_in_report_export: false,
    });
  });

  it("Detailed Expense preserves default-year date range semantics", () => {
    const year = new Date().getFullYear().toString();
    const range = computeDetailedExpenseDateRange(year, "all", "all");
    const p = buildTallySyncParameters({
      reportType: "detailed_expense",
      selectedYear: year,
      selectedMonth: "all",
      selectedWeek: "all",
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    });
    expect(p.year).toBe(year);
    expect(p.date_from).toBe(`${year}-01-01`);
    expect(p.date_to).toBe(`${year}-12-31`);
  });

  it("Daily Project all_time has null dates omitted", () => {
    const p = buildTallySyncParameters({
      reportType: "daily_project_report",
      dateFrom: null,
      dateTo: null,
    });
    expect(p.date_from).toBeUndefined();
    expect(p.date_to).toBeUndefined();
  });

  it("freezes filtered employee and category into parameters", () => {
    const p = buildTallySyncParameters({
      reportType: "claim_verification",
      userId: "11111111-1111-1111-1111-111111111111",
      category: "Travel",
      engineerStatus: "verified",
      customFieldFilters: { Project: "Alpha", Region: "all" },
    });
    expect(p.user_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(p.category).toBe("Travel");
    expect(p.engineer_status).toBe("verified");
    expect(p.custom_field_filters).toEqual({ Project: "Alpha" });
  });

  it("does not include pagination or row payloads", () => {
    const p = buildTallySyncParameters({ reportType: "claim_verification" });
    expect(p).not.toHaveProperty("rows");
    expect(p).not.toHaveProperty("page");
    expect(p).not.toHaveProperty("preview");
  });

  it("does not force a metadata Alter on repeat syncs", () => {
    const p = buildTallySyncParameters({ reportType: "daily_project_report" });
    expect(p).not.toHaveProperty("tally_force_refresh");
  });
});
