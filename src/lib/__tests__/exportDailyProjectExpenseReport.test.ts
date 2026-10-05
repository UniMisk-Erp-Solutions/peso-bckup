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
});
