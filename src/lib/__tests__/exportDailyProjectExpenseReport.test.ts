import { describe, expect, it } from "vitest";
import { dailyReportRowsToSheetAoa } from "@/lib/exportDailyProjectExpenseReport";
import {
  DAILY_PROJECT_REPORT_HEADERS,
  type DailyProjectExpenseReportRow,
} from "@/lib/dailyExpenseReportConfig";

function emptyRow(): DailyProjectExpenseReportRow {
  const row = {} as DailyProjectExpenseReportRow;
  for (const header of DAILY_PROJECT_REPORT_HEADERS) {
    row[header] = "";
  }
  return row;
}

describe("dailyReportRowsToSheetAoa", () => {
  it("uses exact report header order in row 1", () => {
    const aoa = dailyReportRowsToSheetAoa([]);
    expect(aoa[0]).toEqual([...DAILY_PROJECT_REPORT_HEADERS]);
    expect(aoa[0]).toHaveLength(23);
  });

  it("exports cost columns as numbers and text columns as strings", () => {
    const row = emptyRow();
    row["Track Date"] = "02-05-2026";
    row["project id"] = "P-100";
    row["project name"] = "Alpha Site";
    row["Employee"] = "Ravi";
    row["Petrol Cost"] = 500;

    const aoa = dailyReportRowsToSheetAoa([row]);
    expect(aoa).toHaveLength(2);

    const petrolIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("Petrol Cost");
    const materialIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("Material Cost");
    const projectIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("project id");

    expect(aoa[1][petrolIdx]).toBe(500);
    expect(typeof aoa[1][petrolIdx]).toBe("number");
    expect(aoa[1][materialIdx]).toBe("");
    expect(aoa[1][projectIdx]).toBe("P-100");
  });

  // DOC-113 follow-up: a blank cell that was actually CHECKED against the
  // database (canonical data recovery attempted and found nothing, or
  // genuinely ambiguous) must read differently in the export than an
  // unrelated blank column, so a reader never mistakes "confirmed no data"
  // for "hasn't been looked at."
  it("flags a blank project id cell with the no-data marker", () => {
    const row = emptyRow();
    row["project id"] = "";
    row["project name"] = "";

    const aoa = dailyReportRowsToSheetAoa([row]);
    const pidIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("project id");
    expect(aoa[1][pidIdx]).toBe("N/A - no data on record");
  });

  it("flags a blank project name cell with the no-data marker when the project id is not ambiguous", () => {
    const row = emptyRow();
    row["project id"] = "P-200";
    row["project name"] = "";

    const aoa = dailyReportRowsToSheetAoa([row], new Set(["P-999"]));
    const pnameIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("project name");
    expect(aoa[1][pnameIdx]).toBe("N/A - no data on record");
  });

  it("flags a blank project name cell with the ambiguous marker when the project id is known-ambiguous", () => {
    const row = emptyRow();
    row["project id"] = "P-200";
    row["project name"] = "";

    const aoa = dailyReportRowsToSheetAoa([row], new Set(["P-200"]));
    const pnameIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("project name");
    expect(aoa[1][pnameIdx]).toBe("Ambiguous - multiple names on record, unresolved");
  });

  it("never flags a filled cell, even for an ambiguous project id", () => {
    const row = emptyRow();
    row["project id"] = "P-200";
    row["project name"] = "Whatever Was Actually Recorded";

    const aoa = dailyReportRowsToSheetAoa([row], new Set(["P-200"]));
    const pnameIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("project name");
    expect(aoa[1][pnameIdx]).toBe("Whatever Was Actually Recorded");
  });

  it("does not mark other blank columns", () => {
    const row = emptyRow();
    const aoa = dailyReportRowsToSheetAoa([row]);
    const remarksIdx = DAILY_PROJECT_REPORT_HEADERS.indexOf("Remarks");
    expect(aoa[1][remarksIdx]).toBe("");
  });
});
