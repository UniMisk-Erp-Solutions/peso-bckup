import { describe, expect, it } from "vitest";
import {
  computeDetailedExpenseDateRange,
  isoWeekDateRange,
  activeCustomFieldFilters,
} from "../detailedExpenseReportFilters";

describe("isoWeekDateRange", () => {
  it("computes ISO week 1 of a year starting on a Monday (year start boundary)", () => {
    // 2024-01-01 is a Monday, and is ISO week 1 of 2024.
    expect(isoWeekDateRange(2024, 1)).toEqual({ from: "2024-01-01", to: "2024-01-07" });
  });

  it("computes the last ISO week of a year that has 52 weeks (year end boundary)", () => {
    // 2026-12-28 is a Monday; ISO week 53 of 2026 runs 2026-12-28..2027-01-03,
    // and week 52 is the last full week entirely inside 2026.
    expect(isoWeekDateRange(2026, 52)).toEqual({ from: "2026-12-21", to: "2026-12-27" });
  });

  it("computes a week that crosses a month boundary correctly", () => {
    // ISO week 5 of 2026 (year starts on Thursday 2026-01-01, so week 1's
    // Monday is 2025-12-29) crosses from January into February.
    const range = isoWeekDateRange(2026, 5);
    expect(range.from.slice(5, 7)).not.toBe(range.to.slice(5, 7)); // different months
    expect(range.from < range.to).toBe(true);
    // Exactly 7 days apart.
    const from = new Date(range.from + "T00:00:00Z");
    const to = new Date(range.to + "T00:00:00Z");
    expect((to.getTime() - from.getTime()) / (24 * 3600 * 1000)).toBe(6);
  });

  it("every week is Monday to Sunday, 7 days inclusive, for an arbitrary mid-year week", () => {
    const range = isoWeekDateRange(2026, 23);
    const from = new Date(range.from + "T00:00:00Z");
    const to = new Date(range.to + "T00:00:00Z");
    expect(from.getUTCDay()).toBe(1); // Monday
    expect(to.getUTCDay()).toBe(0); // Sunday
    expect((to.getTime() - from.getTime()) / (24 * 3600 * 1000)).toBe(6);
  });
});

describe("computeDetailedExpenseDateRange", () => {
  it("Week takes precedence over Month and Year", () => {
    const result = computeDetailedExpenseDateRange("2026", "3", "23");
    const week = isoWeekDateRange(2026, 23);
    expect(result).toEqual({ dateFrom: week.from, dateTo: week.to, rangeLabel: "Week 23, 2026" });
  });

  it("Month takes precedence over a bare Year when Week is \"all\"", () => {
    const result = computeDetailedExpenseDateRange("2026", "6", "all");
    expect(result).toEqual({ dateFrom: "2026-06-01", dateTo: "2026-06-30", rangeLabel: "June 2026" });
  });

  it("a bare Year covers the full calendar year when Month and Week are both \"all\"", () => {
    const result = computeDetailedExpenseDateRange("2026", "all", "all");
    expect(result).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-12-31", rangeLabel: "2026" });
  });

  it("no Year selected at all means all time", () => {
    const result = computeDetailedExpenseDateRange("", "all", "all");
    expect(result).toEqual({ dateFrom: null, dateTo: null, rangeLabel: "All time" });
  });

  it("resolves a February month range correctly (28 vs 29 days)", () => {
    expect(computeDetailedExpenseDateRange("2026", "2", "all").dateTo).toBe("2026-02-28");
    expect(computeDetailedExpenseDateRange("2028", "2", "all").dateTo).toBe("2028-02-29"); // leap year
  });
});

describe("activeCustomFieldFilters", () => {
  it("drops \"all\"-valued and empty entries, keeps only active filters", () => {
    expect(
      activeCustomFieldFilters({ "Project ID": "P101", "Project Name": "all", Status: "" }),
    ).toEqual({ "Project ID": "P101" });
  });

  it("returns an empty object when nothing is actively filtered", () => {
    expect(activeCustomFieldFilters({ A: "all", B: "" })).toEqual({});
  });
});
