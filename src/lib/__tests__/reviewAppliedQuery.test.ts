import { describe, expect, it } from "vitest";
import {
  appliedSortToServerSort,
  buildAppliedQueryKey,
  customFilterRecordToServer,
  defaultAppliedReviewQuery,
  deriveDateRange,
  deriveExpenseMonthDateRange,
  hasActiveCustomFilters,
  isDefaultSort,
  isServerQueryActive,
  statusToServerStatuses,
  subtractUtcMonthsClamped,
  type AppliedReviewQuery,
} from "@/lib/reviewAppliedQuery";

const base = (over: Partial<AppliedReviewQuery> = {}): AppliedReviewQuery =>
  defaultAppliedReviewQuery(over);

describe("isServerQueryActive — the broadened mode decision (§14)", () => {
  it("a completely-default query is NORMAL mode (§21)", () => {
    expect(isServerQueryActive(base())).toBe(false);
  });

  it("status alone (Level 2 Verified) activates server mode — the owner's exact bug (§5/§45)", () => {
    expect(isServerQueryActive(base({ status: "level_2_verified" }))).toBe(true);
  });

  it("sort alone activates server mode (§17)", () => {
    expect(isServerQueryActive(base({ sortBy: "trip_start", sortOrder: "asc" }))).toBe(true);
    expect(isServerQueryActive(base({ sortOrder: "asc" }))).toBe(true);
  });

  it("time period alone activates server mode (§18)", () => {
    expect(isServerQueryActive(base({ timePeriod: "month" }))).toBe(true);
  });

  it("a custom filter alone activates server mode (§19)", () => {
    expect(isServerQueryActive(base({ customFilters: { Vehicle: "Car" } }))).toBe(true);
  });

  it("employee or general search still activate server mode", () => {
    expect(isServerQueryActive(base({ employeeUserId: "u-1" }))).toBe(true);
    expect(isServerQueryActive(base({ generalSearch: "CCTV" }))).toBe(true);
  });

  it("actionable and hierarchy toggles alone do NOT activate server mode (§41/§42)", () => {
    expect(isServerQueryActive(base({ showOnlyActionable: true }))).toBe(false);
    expect(isServerQueryActive(base({ includeTeamLeaderReports: true }))).toBe(false);
    expect(isServerQueryActive(base({ includeExecutiveReports: true }))).toBe(false);
  });

  it("an exact expense month alone activates server mode (§13)", () => {
    expect(isServerQueryActive(base({ expenseMonth: "2026-08" }))).toBe(true);
  });

  it("expenseMonth 'all' does not activate server mode on its own", () => {
    expect(isServerQueryActive(base({ expenseMonth: "all" }))).toBe(false);
  });
});

describe("server parameter mappings", () => {
  it("status → statuses; all → null (§16)", () => {
    expect(statusToServerStatuses("all")).toBeNull();
    expect(statusToServerStatuses("level_2_verified")).toEqual(["level_2_verified"]);
  });

  it("sort passthrough matches the queue enum (§17)", () => {
    expect(appliedSortToServerSort("created_at", "desc")).toBe("created_desc");
    expect(appliedSortToServerSort("created_at", "asc")).toBe("created_asc");
    expect(appliedSortToServerSort("trip_start", "desc")).toBe("expense_date_desc");
    expect(appliedSortToServerSort("trip_start", "asc")).toBe("expense_date_asc");
  });

  it("deriveDateRange is deterministic from an injected now (§18)", () => {
    const now = new Date("2026-08-11T00:00:00.000Z");
    expect(deriveDateRange("all", now)).toEqual({ from: null, to: null });
    expect(deriveDateRange("week", now).from).toBe("2026-08-04T00:00:00.000Z");
    expect(deriveDateRange("month", now).from).toBe("2026-07-11T00:00:00.000Z");
    expect(deriveDateRange("year", now).from).toBe("2025-08-11T00:00:00.000Z");
  });

  it("deriveDateRange recognizes mobile's 7d/30d/3m/6m/1y values (§19-20) -- previously produced NO bound at all", () => {
    const now = new Date("2026-08-11T00:00:00.000Z");
    expect(deriveDateRange("7d", now).from).toBe("2026-08-04T00:00:00.000Z");
    expect(deriveDateRange("7d", now)).toEqual(deriveDateRange("week", now));
    expect(deriveDateRange("30d", now).from).toBe("2026-07-12T00:00:00.000Z");
    expect(deriveDateRange("3m", now).from).toBe("2026-05-11T00:00:00.000Z");
    expect(deriveDateRange("6m", now).from).toBe("2026-02-11T00:00:00.000Z");
    expect(deriveDateRange("1y", now).from).toBe("2025-08-11T00:00:00.000Z");
    expect(deriveDateRange("1y", now)).toEqual(deriveDateRange("year", now));
  });

  it("deriveDateRange never bounds the upper end (to is always null) for any relative period", () => {
    const now = new Date("2026-08-11T00:00:00.000Z");
    for (const v of ["week", "month", "year", "7d", "30d", "3m", "6m", "1y"]) {
      expect(deriveDateRange(v, now).to).toBeNull();
    }
  });
});

describe("subtractUtcMonthsClamped -- calendar-arithmetic correctness (final pre-production pass)", () => {
  const iso = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

  it("March 31 minus one month clamps to Feb 28 (non-leap) instead of overflowing to March", () => {
    const result = subtractUtcMonthsClamped(new Date("2026-03-31T00:00:00.000Z"), 1);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2026, 2, 28));
  });

  it("leap-year March 31 minus one month clamps to Feb 29", () => {
    const result = subtractUtcMonthsClamped(new Date("2024-03-31T00:00:00.000Z"), 1);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2024, 2, 29));
  });

  it("May 31 minus 3 months clamps to Feb 28", () => {
    const result = subtractUtcMonthsClamped(new Date("2026-05-31T00:00:00.000Z"), 3);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2026, 2, 28));
  });

  it("August 31 minus 6 months clamps to Feb 28", () => {
    const result = subtractUtcMonthsClamped(new Date("2026-08-31T00:00:00.000Z"), 6);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2026, 2, 28));
  });

  it("January 31 minus one month rolls back to December 31 of the PRIOR year", () => {
    const result = subtractUtcMonthsClamped(new Date("2026-01-31T00:00:00.000Z"), 1);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2025, 12, 31));
  });

  it("Feb 29 (leap) minus one year (12 months) clamps to Feb 28 of a non-leap year", () => {
    const result = subtractUtcMonthsClamped(new Date("2024-02-29T00:00:00.000Z"), 12);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2023, 2, 28));
  });

  it("Feb 28 minus one year stays Feb 28 -- no unwanted clamping when the day already fits", () => {
    const result = subtractUtcMonthsClamped(new Date("2026-02-28T00:00:00.000Z"), 12);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2025, 2, 28));
  });

  it("a normal mid-month date is unaffected -- same day, month rolled back", () => {
    const result = subtractUtcMonthsClamped(new Date("2026-06-15T00:00:00.000Z"), 1);
    expect(result.toISOString().slice(0, 10)).toBe(iso(2026, 5, 15));
  });

  it("preserves the time-of-day exactly", () => {
    const result = subtractUtcMonthsClamped(new Date("2026-03-31T14:37:22.123Z"), 1);
    expect(result.toISOString()).toBe("2026-02-28T14:37:22.123Z");
  });

  it("deriveDateRange's month/3m/6m/year/1y branches now use the clamped subtraction end-to-end", () => {
    const now = new Date("2026-03-31T00:00:00.000Z");
    expect(deriveDateRange("month", now).from).toBe("2026-02-28T00:00:00.000Z");
    expect(deriveDateRange("3m", new Date("2026-05-31T00:00:00.000Z")).from).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(deriveDateRange("6m", new Date("2026-08-31T00:00:00.000Z")).from).toBe(
      "2026-02-28T00:00:00.000Z",
    );
    expect(deriveDateRange("year", new Date("2024-02-29T00:00:00.000Z")).from).toBe(
      "2023-02-28T00:00:00.000Z",
    );
    expect(deriveDateRange("1y", new Date("2024-02-29T00:00:00.000Z")).from).toBe(
      "2023-02-28T00:00:00.000Z",
    );
  });

  it("deriveDateRange's 7d/30d branches are unaffected -- exact day-count subtraction, immune to month-length overflow by construction", () => {
    const now = new Date("2026-03-31T00:00:00.000Z");
    expect(deriveDateRange("7d", now).from).toBe("2026-03-24T00:00:00.000Z");
    expect(deriveDateRange("30d", now).from).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("server parameter mappings (continued)", () => {
  it("deriveExpenseMonthDateRange derives inclusive-end bounds for the RPC's <= date_to contract (§9)", () => {
    expect(deriveExpenseMonthDateRange("all")).toEqual({ from: null, to: null });
    expect(deriveExpenseMonthDateRange("2026-08")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(deriveExpenseMonthDateRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" }); // leap year
    expect(deriveExpenseMonthDateRange("2025-12")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("isDefaultSort / hasActiveCustomFilters helpers", () => {
    expect(isDefaultSort("created_at", "desc")).toBe(true);
    expect(isDefaultSort("created_at", "asc")).toBe(false);
    expect(hasActiveCustomFilters({ Vehicle: "all" })).toBe(false);
    expect(hasActiveCustomFilters({ Vehicle: "all", Zone: "North" })).toBe(true);
    expect(hasActiveCustomFilters({})).toBe(false);
  });
});

describe("customFilterRecordToServer (§19)", () => {
  const resolve = (label: string) => {
    if (label === "Vehicle") return [{ source: "template" as const, field_id: "tpl-veh" }];
    if (label === "Zone")
      return [
        { source: "branch" as const, field_id: "br-zone" },
        { source: "template" as const, field_id: "tpl-zone" },
      ];
    return [];
  };

  it("maps a single-field label to one server predicate", () => {
    expect(customFilterRecordToServer({ Vehicle: "Car" }, resolve)).toEqual([
      { source: "template", field_id: "tpl-veh", values: ["Car"] },
    ]);
  });

  it("skips 'all' and unresolvable labels", () => {
    expect(
      customFilterRecordToServer({ Vehicle: "all", Unknown: "X" }, resolve),
    ).toEqual([]);
  });

  it("a duplicate-label field deterministically takes template before branch (documented limitation)", () => {
    expect(customFilterRecordToServer({ Zone: "North" }, resolve)).toEqual([
      { source: "template", field_id: "tpl-zone", values: ["North"] },
    ]);
  });
});

describe("buildAppliedQueryKey (§37)", () => {
  it("is independent of revision (two identical submits share a key)", () => {
    expect(buildAppliedQueryKey(base({ status: "approved", revision: 1 }))).toBe(
      buildAppliedQueryKey(base({ status: "approved", revision: 9 })),
    );
  });

  it("changes when custom filters change — the field the old key omitted", () => {
    const a = buildAppliedQueryKey(base({ customFilters: { Vehicle: "Car" } }));
    const b = buildAppliedQueryKey(base({ customFilters: { Vehicle: "Bus" } }));
    expect(a).not.toBe(b);
  });

  it("changes when the actionable or hierarchy toggles change (§37)", () => {
    expect(buildAppliedQueryKey(base())).not.toBe(
      buildAppliedQueryKey(base({ showOnlyActionable: true })),
    );
    expect(buildAppliedQueryKey(base())).not.toBe(
      buildAppliedQueryKey(base({ includeExecutiveReports: true })),
    );
  });

  it("normal vs server mode are distinguishable in the key", () => {
    expect(buildAppliedQueryKey(base())).toContain("normal");
    expect(buildAppliedQueryKey(base({ status: "level_2_verified" }))).toContain("server");
  });

  it("distinct expense months never share cache identity (§14)", () => {
    const allMonths = buildAppliedQueryKey(base({ expenseMonth: "all" }));
    const august = buildAppliedQueryKey(base({ expenseMonth: "2026-08" }));
    const september = buildAppliedQueryKey(base({ expenseMonth: "2026-09" }));
    expect(new Set([allMonths, august, september]).size).toBe(3);
  });
});
