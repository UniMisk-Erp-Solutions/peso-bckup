import { describe, expect, it } from "vitest";
import {
  buildDailyProjectExpenseReportRows,
  dailyReportResultsToRows,
  payrollPercentForEmployeeDay,
} from "@/lib/buildDailyProjectExpenseReport";
import {
  emptyDailyExpenseReportConfig,
  encodeBaseFieldSource,
  encodeTemplateSource,
  isDailyReportRowNeedsReview,
} from "@/lib/dailyExpenseReportConfig";

const USER = "user-1";

function baseConfig() {
  const cfg = emptyDailyExpenseReportConfig();
  cfg.fieldMappings.projectId = encodeTemplateSource("tpl-project-id");
  cfg.fieldMappings.projectName = encodeTemplateSource("tpl-project-name");
  cfg.fieldMappings.location = encodeBaseFieldSource("destination");
  cfg.categoryMappings.petrol_cost = ["Fuel", "Petrol"];
  cfg.categoryMappings.material_cost = ["Materials"];
  cfg.categoryMappings.travelling_cost = ["Travel"];
  return cfg;
}

describe("buildDailyProjectExpenseReportRows", () => {
  it("groups same employee and day by project into separate rows", () => {
    const rows = dailyReportResultsToRows(buildDailyProjectExpenseReportRows({
      expenses: [
        {
          id: "e1",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Fuel",
          total_amount: 500,
          destination: "Site A",
        },
        {
          id: "e2",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Materials",
          total_amount: 200,
          destination: "Site B",
        },
      ],
      profilesByUserId: {
        [USER]: { user_id: USER, name: "Ravi", employee_id: "EMP01" },
      },
      fieldValuesByExpenseId: {
        e1: { projectId: "P1", projectName: "Alpha", location: "Site A" },
        e2: { projectId: "P2", projectName: "Beta", location: "Site B" },
      },
      config: baseConfig(),
    }));

    expect(rows).toHaveLength(2);
    expect(rows[0]["Track Date"]).toBe("10-05-2026");
    expect(rows[0]["Employee"]).toBe("Ravi");
    expect(rows[0]["Employee Code"]).toBe("EMP01");
    expect(rows[0]["project id"]).toBe("P1");
    expect(rows[0]["Petrol Cost"]).toBe(500);
    expect(rows[0]["Presence"]).toBe("P");
    expect(rows[0]["Location"]).toBe("Site A");
    expect(rows[0]["percent"]).toBe(50);
    expect(rows[1]["project id"]).toBe("P2");
    expect(rows[1]["Material Cost"]).toBe(200);
    expect(rows[1]["Presence"]).toBe("P");
    expect(rows[1]["percent"]).toBe(50);
  });

  it("merges rows with the same project id even when project names differ", () => {
    const rows = dailyReportResultsToRows(buildDailyProjectExpenseReportRows({
      expenses: [
        {
          id: "e1",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Fuel",
          total_amount: 300,
        },
        {
          id: "e2",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Fuel",
          total_amount: 200,
        },
      ],
      profilesByUserId: {
        [USER]: { user_id: USER, name: "Ravi", employee_id: "EMP01" },
      },
      fieldValuesByExpenseId: {
        e1: { projectId: "P1", projectName: "", location: "Site A" },
        e2: { projectId: "P1", projectName: "Alpha", location: "Site A" },
      },
      config: baseConfig(),
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]["project id"]).toBe("P1");
    expect(rows[0]["project name"]).toBe("Alpha");
    expect(rows[0]["Petrol Cost"]).toBe(500);
  });

  it("merges multiple expenses into one row per project per day", () => {
    const rows = dailyReportResultsToRows(buildDailyProjectExpenseReportRows({
      expenses: [
        {
          id: "e1",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Fuel",
          total_amount: 300,
        },
        {
          id: "e2",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Petrol",
          total_amount: 200,
        },
      ],
      profilesByUserId: {
        [USER]: { user_id: USER, name: "Ravi", employee_id: "EMP01" },
      },
      fieldValuesByExpenseId: {
        e1: { projectId: "P1", projectName: "Alpha", location: "Site A" },
        e2: { projectId: "P1", projectName: "Alpha", location: "Site A" },
      },
      config: baseConfig(),
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]["Petrol Cost"]).toBe(500);
    expect(rows[0]["Presence"]).toBe("P");
    expect(rows[0]["percent"]).toBe(100);
  });

  it("puts unmapped categories into Other Exp.", () => {
    const rows = dailyReportResultsToRows(buildDailyProjectExpenseReportRows({
      expenses: [
        {
          id: "e1",
          user_id: USER,
          trip_start: "2026-05-11",
          category: "Miscellaneous",
          total_amount: 99,
        },
      ],
      profilesByUserId: {
        [USER]: { user_id: USER, name: "Ravi", employee_id: null },
      },
      fieldValuesByExpenseId: {
        e1: { projectId: "", projectName: "", location: "" },
      },
      config: baseConfig(),
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]["Other Exp."]).toBe(99);
    expect(rows[0]["Employee Code"]).toBe("");
    expect(rows[0]["Presence"]).toBe("P");
    expect(rows[0]["percent"]).toBe(100);
  });

  it("splits percent across three projects on the same day", () => {
    const rows = dailyReportResultsToRows(buildDailyProjectExpenseReportRows({
      expenses: [
        { id: "e1", user_id: USER, trip_start: "2026-05-10", category: "Fuel", total_amount: 100 },
        { id: "e2", user_id: USER, trip_start: "2026-05-10", category: "Fuel", total_amount: 100 },
        { id: "e3", user_id: USER, trip_start: "2026-05-10", category: "Fuel", total_amount: 100 },
      ],
      profilesByUserId: {
        [USER]: { user_id: USER, name: "Ravi", employee_id: "EMP01" },
      },
      fieldValuesByExpenseId: {
        e1: { projectId: "P1", projectName: "A", location: "L1" },
        e2: { projectId: "P2", projectName: "B", location: "L2" },
        e3: { projectId: "P3", projectName: "C", location: "L3" },
      },
      config: baseConfig(),
    }));

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row["percent"]).toBe(33.33);
      expect(row["Presence"]).toBe("P");
    }
  });

  it("tracks source expenses on merged rows", () => {
    const results = buildDailyProjectExpenseReportRows({
      expenses: [
        {
          id: "e1",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Fuel",
          total_amount: 300,
        },
        {
          id: "e2",
          user_id: USER,
          trip_start: "2026-05-10",
          category: "Petrol",
          total_amount: 200,
        },
      ],
      profilesByUserId: {
        [USER]: { user_id: USER, name: "Ravi", employee_id: "EMP01" },
      },
      fieldValuesByExpenseId: {
        e1: { projectId: "P1", projectName: "Alpha", location: "Site A" },
        e2: { projectId: "P1", projectName: "Alpha", location: "Site A" },
      },
      config: baseConfig(),
    });

    expect(results).toHaveLength(1);
    expect(results[0].sourceExpenses).toHaveLength(2);
    expect(results[0].sourceExpenses.map((exp) => exp.id)).toEqual(["e1", "e2"]);
  });
});

describe("payrollPercentForEmployeeDay", () => {
  it("returns 100 for a single project", () => {
    expect(payrollPercentForEmployeeDay(1)).toBe(100);
  });

  it("returns even split for multiple projects", () => {
    expect(payrollPercentForEmployeeDay(2)).toBe(50);
    expect(payrollPercentForEmployeeDay(4)).toBe(25);
  });
});

describe("isDailyReportRowNeedsReview", () => {
  it("flags rows missing project id or name", () => {
    const row = {} as import("@/lib/dailyExpenseReportConfig").DailyProjectExpenseReportRow;
    row["project id"] = "P1";
    row["project name"] = "";
    expect(isDailyReportRowNeedsReview(row)).toBe(true);
    row["project name"] = "Alpha";
    expect(isDailyReportRowNeedsReview(row)).toBe(false);
  });
});
