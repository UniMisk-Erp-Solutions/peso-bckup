import { describe, it, expect } from "vitest";
import {
  isExpenseMonthValue,
  expenseMonthBounds,
  expenseMonthInclusiveEnd,
  formatExpenseMonthLabel,
  buildExpenseMonthOptions,
  expenseMonthOf,
  expenseMonthOfDateString,
} from "@/lib/expenseMonthFilter";

describe("isExpenseMonthValue", () => {
  it("accepts 'all'", () => {
    expect(isExpenseMonthValue("all")).toBe(true);
  });
  it("accepts well-formed YYYY-MM values", () => {
    expect(isExpenseMonthValue("2026-08")).toBe(true);
    expect(isExpenseMonthValue("2026-01")).toBe(true);
    expect(isExpenseMonthValue("2026-12")).toBe(true);
  });
  it("rejects month 00 or 13", () => {
    expect(isExpenseMonthValue("2026-00")).toBe(false);
    expect(isExpenseMonthValue("2026-13")).toBe(false);
  });
  it("rejects malformed strings", () => {
    expect(isExpenseMonthValue("2026-8")).toBe(false);
    expect(isExpenseMonthValue("Aug 2026")).toBe(false);
    expect(isExpenseMonthValue("")).toBe(false);
    expect(isExpenseMonthValue(null)).toBe(false);
    expect(isExpenseMonthValue(undefined)).toBe(false);
    expect(isExpenseMonthValue(42)).toBe(false);
  });
});

describe("expenseMonthBounds -- half-open range semantics (§50)", () => {
  it("returns null for 'all' (no bound)", () => {
    expect(expenseMonthBounds("all")).toBeNull();
  });

  it("February 2024 (leap year): 2024-02-01 inclusive .. 2024-03-01 exclusive", () => {
    expect(expenseMonthBounds("2024-02")).toEqual({ from: "2024-02-01", toExclusive: "2024-03-01" });
  });

  it("December 2025 rolls into January 2026: 2025-12-01 .. 2026-01-01 exclusive", () => {
    expect(expenseMonthBounds("2025-12")).toEqual({ from: "2025-12-01", toExclusive: "2026-01-01" });
  });

  it("January rolls back from the previous December correctly", () => {
    expect(expenseMonthBounds("2026-01")).toEqual({ from: "2026-01-01", toExclusive: "2026-02-01" });
  });

  it("a non-leap February still rolls to March correctly", () => {
    expect(expenseMonthBounds("2025-02")).toEqual({ from: "2025-02-01", toExclusive: "2025-03-01" });
  });

  it("August 2026 bounds match the spec's own example exactly", () => {
    expect(expenseMonthBounds("2026-08")).toEqual({ from: "2026-08-01", toExclusive: "2026-09-01" });
  });

  it("returns null for an invalid value rather than throwing", () => {
    expect(expenseMonthBounds("not-a-month" as never)).toBeNull();
  });
});

describe("expenseMonthInclusiveEnd -- adapter for an inclusive-<=-date_to server contract", () => {
  it("August's exclusive Sept 1 becomes inclusive August 31", () => {
    expect(expenseMonthInclusiveEnd("2026-09-01")).toBe("2026-08-31");
  });
  it("February 2024 (leap year) exclusive March 1 becomes inclusive Feb 29", () => {
    expect(expenseMonthInclusiveEnd("2024-03-01")).toBe("2024-02-29");
  });
  it("February 2025 (non-leap) exclusive March 1 becomes inclusive Feb 28", () => {
    expect(expenseMonthInclusiveEnd("2025-03-01")).toBe("2025-02-28");
  });
  it("January's exclusive boundary correctly rolls back into December of the prior year", () => {
    expect(expenseMonthInclusiveEnd("2026-01-01")).toBe("2025-12-31");
  });
});

describe("month boundary authority: exact trip_start values on either side of a rollover (§50)", () => {
  it("2026-08-31 belongs to August; 2026-09-01 belongs to September", () => {
    const augustBounds = expenseMonthBounds("2026-08")!;
    const augEnd = "2026-08-31";
    const sepStart = "2026-09-01";
    expect(augEnd >= augustBounds.from && augEnd < augustBounds.toExclusive).toBe(true);
    expect(sepStart >= augustBounds.from && sepStart < augustBounds.toExclusive).toBe(false);

    const septemberBounds = expenseMonthBounds("2026-09")!;
    expect(sepStart >= septemberBounds.from && sepStart < septemberBounds.toExclusive).toBe(true);
    expect(augEnd >= septemberBounds.from && augEnd < septemberBounds.toExclusive).toBe(false);
  });
});

describe("formatExpenseMonthLabel", () => {
  it("formats 'all' as 'All months'", () => {
    expect(formatExpenseMonthLabel("all")).toBe("All months");
  });
  it("formats a month value as 'MMMM yyyy'", () => {
    expect(formatExpenseMonthLabel("2026-09")).toBe("September 2026");
    expect(formatExpenseMonthLabel("2026-01")).toBe("January 2026");
    expect(formatExpenseMonthLabel("2025-12")).toBe("December 2025");
  });
  it("falls back to 'All months' for a malformed value rather than throwing", () => {
    expect(formatExpenseMonthLabel("garbage" as never)).toBe("All months");
  });
});

describe("expenseMonthOf / expenseMonthOfDateString", () => {
  it("derives the UTC month from a Date", () => {
    expect(expenseMonthOf(new Date(Date.UTC(2026, 8, 15)))).toBe("2026-09"); // JS month is 0-based
  });
  it("derives the month from a trip_start date string", () => {
    expect(expenseMonthOfDateString("2026-08-29")).toBe("2026-08");
    expect(expenseMonthOfDateString("2026-08-29T00:00:00.000Z")).toBe("2026-08");
  });
});

describe("buildExpenseMonthOptions -- every calendar month, newest first (§3/§4/§49)", () => {
  it("returns only 'All months' when there is no accessible history", () => {
    const opts = buildExpenseMonthOptions({ earliest: null, now: new Date(Date.UTC(2026, 8, 1)) });
    expect(opts).toEqual([{ value: "all", label: "All months" }]);
  });

  it("generates every month from earliest=March 2025 to current=September 2026, newest first, ALL included even zero-data ones", () => {
    const opts = buildExpenseMonthOptions({
      earliest: "2025-03",
      now: new Date(Date.UTC(2026, 8, 15)), // September 2026
    });
    const values = opts.map((o) => o.value);
    expect(values[0]).toBe("all");
    expect(values[1]).toBe("2026-09"); // newest first
    expect(values[values.length - 1]).toBe("2025-03"); // oldest last
    // Every month present, no gaps -- 19 months (Mar 2025..Sep 2026 inclusive) + "all".
    expect(values).toHaveLength(1 + 19);
    expect(values).toContain("2026-06"); // must appear even with zero expenses
    expect(values).toContain("2025-12");
    expect(values).toContain("2025-03");
    expect(values).not.toContain("2025-02");
    expect(values).not.toContain("2026-10");
  });

  it("labels are 'MMMM yyyy' and sorted newest-first after 'All months'", () => {
    const opts = buildExpenseMonthOptions({ earliest: "2026-06", now: new Date(Date.UTC(2026, 7, 1)) }); // Aug 2026
    expect(opts.map((o) => o.label)).toEqual(["All months", "August 2026", "July 2026", "June 2026"]);
  });

  it("extends the upper bound to a future-dated expense month beyond the current month (§4)", () => {
    const opts = buildExpenseMonthOptions({
      earliest: "2026-06",
      now: new Date(Date.UTC(2026, 7, 1)), // August 2026 "current"
      latestExpenseMonth: "2026-11", // a legitimate future trip_start
    });
    const values = opts.map((o) => o.value);
    expect(values[1]).toBe("2026-11"); // newest first includes the future month
    expect(values).toContain("2026-09");
    expect(values).toContain("2026-10");
    expect(values).toContain("2026-08");
  });

  it("does not extend the range when the latest accessible expense month is in the past relative to now", () => {
    const opts = buildExpenseMonthOptions({
      earliest: "2026-01",
      now: new Date(Date.UTC(2026, 8, 1)), // September 2026 "current"
      latestExpenseMonth: "2026-03", // stale/past -- current month should still win as upper bound
    });
    expect(opts[1].value).toBe("2026-09");
  });

  it("handles earliest === latest (single month) without infinite looping", () => {
    const opts = buildExpenseMonthOptions({ earliest: "2026-05", now: new Date(Date.UTC(2026, 4, 1)) });
    expect(opts.map((o) => o.value)).toEqual(["all", "2026-05"]);
  });

  it("crosses a year boundary cleanly (December -> next January in reverse iteration)", () => {
    const opts = buildExpenseMonthOptions({ earliest: "2025-11", now: new Date(Date.UTC(2026, 0, 1)) }); // Jan 2026
    expect(opts.map((o) => o.value)).toEqual(["all", "2026-01", "2025-12", "2025-11"]);
  });
});
