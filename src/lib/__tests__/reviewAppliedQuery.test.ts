import { describe, expect, it } from "vitest";
import {
  appliedSortToServerSort,
  buildAppliedQueryKey,
  customFilterRecordToServer,
  defaultAppliedReviewQuery,
  deriveDateRange,
  hasActiveCustomFilters,
  isDefaultSort,
  isServerQueryActive,
  statusToServerStatuses,
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
});
