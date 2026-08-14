import { describe, it, expect } from "vitest";
import {
  safeAmount,
  computeMedian,
  classifyExpenseStatus,
  getExpenseStatusOrder,
  resolveGranularity,
  dateToKey,
  generateBucketKeys,
  bucketKeyToLabel,
  computePreviousPeriod,
  getExpenseDate,
  computeKPIs,
  computeChange,
  buildTrend,
  buildCategoryBreakdown,
  buildStatusBreakdown,
  buildDestinationBreakdown,
  buildEmployeeBreakdown,
  buildPendingAging,
  buildAmountHistogram,
  buildWeekdayBreakdown,
  buildCumulativeSpend,
  type AnalyticsExpenseRow,
  type AnalyticsProfile,
} from "@/lib/analytics/expenseAnalytics";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function row(overrides: Partial<AnalyticsExpenseRow> = {}): AnalyticsExpenseRow {
  return {
    id: "e1",
    organization_id: "org1",
    user_id: "u1",
    title: "Test expense",
    transaction_number: null,
    status: "approved",
    total_amount: 1000,
    category: "Travel",
    destination: "Mumbai",
    trip_start: "2024-03-15T00:00:00Z",
    trip_end: null,
    created_at: "2024-03-10T09:00:00Z",
    updated_at: null,
    batch_id: null,
    approval_tier: null,
    assigned_engineer_id: null,
    assigned_reviewer_id: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// safeAmount
// ─────────────────────────────────────────────────────────────────────────────

describe("safeAmount", () => {
  it("handles numeric values", () => {
    expect(safeAmount(500)).toBe(500);
  });
  it("parses string numbers", () => {
    expect(safeAmount("1234.56")).toBeCloseTo(1234.56);
  });
  it("returns 0 for null", () => {
    expect(safeAmount(null)).toBe(0);
  });
  it("returns 0 for undefined", () => {
    expect(safeAmount(undefined)).toBe(0);
  });
  it("returns 0 for NaN string", () => {
    expect(safeAmount("not-a-number")).toBe(0);
  });
  it("returns 0 for Infinity", () => {
    expect(safeAmount(Infinity)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeMedian
// ─────────────────────────────────────────────────────────────────────────────

describe("computeMedian", () => {
  it("returns 0 for empty array", () => {
    expect(computeMedian([])).toBe(0);
  });
  it("handles single element", () => {
    expect(computeMedian([42])).toBe(42);
  });
  it("returns middle for odd-length array", () => {
    expect(computeMedian([1, 3, 5])).toBe(3);
  });
  it("returns average of two middle values for even-length array", () => {
    expect(computeMedian([1, 3, 5, 7])).toBe(4);
  });
  it("is not affected by insertion order", () => {
    expect(computeMedian([5, 1, 3])).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyExpenseStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyExpenseStatus", () => {
  it("classifies approved as approved", () => {
    expect(classifyExpenseStatus("approved")).toBe("approved");
  });
  it("classifies paid as approved", () => {
    expect(classifyExpenseStatus("paid")).toBe("approved");
  });
  it("classifies rejected as rejected", () => {
    expect(classifyExpenseStatus("rejected")).toBe("rejected");
  });
  it("classifies submitted as pending", () => {
    expect(classifyExpenseStatus("submitted")).toBe("pending");
  });
  it("classifies under_review as pending", () => {
    expect(classifyExpenseStatus("under_review")).toBe("pending");
  });
  it("classifies level_1_verified as pending", () => {
    expect(classifyExpenseStatus("level_1_verified")).toBe("pending");
  });
  it("classifies level_2_verified as pending", () => {
    expect(classifyExpenseStatus("level_2_verified")).toBe("pending");
  });
  it("classifies verified as pending", () => {
    expect(classifyExpenseStatus("verified")).toBe("pending");
  });
  it("classifies edited as pending", () => {
    expect(classifyExpenseStatus("edited")).toBe("pending");
  });
  it("classifies draft as draft", () => {
    expect(classifyExpenseStatus("draft")).toBe("draft");
  });
  it("classifies unknown status as other", () => {
    expect(classifyExpenseStatus("unknown_xyz")).toBe("other");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getExpenseStatusOrder
// ─────────────────────────────────────────────────────────────────────────────

describe("getExpenseStatusOrder", () => {
  it("submitted comes before approved", () => {
    expect(getExpenseStatusOrder("submitted")).toBeLessThan(getExpenseStatusOrder("approved"));
  });
  it("approved comes before rejected", () => {
    expect(getExpenseStatusOrder("approved")).toBeLessThan(getExpenseStatusOrder("rejected"));
  });
  it("unknown statuses get high order", () => {
    expect(getExpenseStatusOrder("totally_made_up")).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveGranularity
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveGranularity", () => {
  const d = (s: string) => new Date(s);
  it("passes through explicit daily", () => {
    expect(resolveGranularity("daily", d("2024-01-01"), d("2024-12-31"))).toBe("daily");
  });
  it("passes through explicit weekly", () => {
    expect(resolveGranularity("weekly", d("2024-01-01"), d("2024-12-31"))).toBe("weekly");
  });
  it("passes through explicit monthly", () => {
    expect(resolveGranularity("monthly", d("2024-01-01"), d("2024-12-31"))).toBe("monthly");
  });
  it("auto: ≤45 days → daily", () => {
    expect(resolveGranularity("auto", d("2024-03-01"), d("2024-03-30"))).toBe("daily");
  });
  it("auto: 46–180 days → weekly", () => {
    expect(resolveGranularity("auto", d("2024-01-01"), d("2024-04-30"))).toBe("weekly");
  });
  it("auto: >180 days → monthly", () => {
    expect(resolveGranularity("auto", d("2023-01-01"), d("2024-01-01"))).toBe("monthly");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dateToKey
// ─────────────────────────────────────────────────────────────────────────────

describe("dateToKey", () => {
  it("daily: produces yyyy-MM-dd", () => {
    expect(dateToKey(new Date("2024-03-15"), "daily")).toBe("2024-03-15");
  });
  it("monthly: produces yyyy-MM", () => {
    expect(dateToKey(new Date("2024-03-15"), "monthly")).toBe("2024-03");
  });
  it("weekly: produces yyyy-Www format", () => {
    const key = dateToKey(new Date("2024-03-18"), "weekly");
    expect(key).toMatch(/^\d{4}-W\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bucketKeyToLabel
// ─────────────────────────────────────────────────────────────────────────────

describe("bucketKeyToLabel", () => {
  it("formats monthly key", () => {
    expect(bucketKeyToLabel("2024-03")).toContain("Mar");
  });
  it("formats weekly key", () => {
    const label = bucketKeyToLabel("2024-W11");
    expect(label).toContain("W11");
  });
  it("formats daily key as MM/DD", () => {
    expect(bucketKeyToLabel("2024-03-15")).toBe("03/15");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computePreviousPeriod
// ─────────────────────────────────────────────────────────────────────────────

describe("computePreviousPeriod", () => {
  it("previous period has same duration", () => {
    const from = new Date("2024-03-01");
    const to = new Date("2024-03-31");
    const { prevFrom, prevTo } = computePreviousPeriod(from, to);
    const duration = to.getTime() - from.getTime();
    const prevDuration = prevTo.getTime() - prevFrom.getTime();
    expect(Math.abs(prevDuration - duration)).toBeLessThanOrEqual(1000);
  });
  it("previous period ends before current period starts", () => {
    const from = new Date("2024-03-01");
    const to = new Date("2024-03-31");
    const { prevTo } = computePreviousPeriod(from, to);
    expect(prevTo.getTime()).toBeLessThan(from.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getExpenseDate
// ─────────────────────────────────────────────────────────────────────────────

describe("getExpenseDate", () => {
  it("expense_date returns trip_start", () => {
    const r = row({ trip_start: "2024-03-15T00:00:00Z" });
    const d = getExpenseDate(r, "expense_date");
    expect(d?.getMonth()).toBe(2); // March = index 2
  });
  it("submitted_date returns created_at", () => {
    const r = row({ created_at: "2024-03-10T09:00:00Z" });
    const d = getExpenseDate(r, "submitted_date");
    expect(d?.getDate()).toBe(10);
  });
  it("returns null when trip_start is null for expense_date", () => {
    const r = row({ trip_start: null });
    expect(getExpenseDate(r, "expense_date")).toBeNull();
  });
  it("returns null for invalid date string", () => {
    const r = row({ trip_start: "not-a-date" });
    expect(getExpenseDate(r, "expense_date")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeKPIs
// ─────────────────────────────────────────────────────────────────────────────

describe("computeKPIs", () => {
  it("returns zero KPIs for empty array", () => {
    const kpis = computeKPIs([]);
    expect(kpis.totalAmount).toBe(0);
    expect(kpis.totalCount).toBe(0);
    expect(kpis.finalizedApprovalRate).toBeNull();
  });

  it("sums total amount correctly", () => {
    const rows = [row({ total_amount: 1000 }), row({ total_amount: 2000 })];
    expect(computeKPIs(rows).totalAmount).toBe(3000);
  });

  it("computes approval rate as approved/(approved+rejected)", () => {
    const rows = [
      row({ status: "approved", total_amount: 1000 }),
      row({ status: "approved", total_amount: 500 }),
      row({ status: "rejected", total_amount: 300 }),
    ];
    const kpis = computeKPIs(rows);
    // 2 approved, 1 rejected → 2/3 ≈ 66.67%
    expect(kpis.finalizedApprovalRate).toBeCloseTo((2 / 3) * 100, 2);
  });

  it("pending expenses do not affect approval rate denominator", () => {
    const rows = [
      row({ status: "approved", total_amount: 1000 }),
      row({ status: "submitted", total_amount: 500 }),
    ];
    const kpis = computeKPIs(rows);
    // 1 approved, 0 rejected → 100%
    expect(kpis.finalizedApprovalRate).toBe(100);
  });

  it("counts active submitters correctly", () => {
    const rows = [
      row({ user_id: "u1" }),
      row({ user_id: "u2" }),
      row({ user_id: "u1" }),
    ];
    expect(computeKPIs(rows).activeSubmitters).toBe(2);
  });

  it("handles string amounts", () => {
    const rows = [row({ total_amount: "1500.50" })];
    expect(computeKPIs(rows).totalAmount).toBeCloseTo(1500.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeChange
// ─────────────────────────────────────────────────────────────────────────────

describe("computeChange", () => {
  it("returns new when prev is 0 and current > 0", () => {
    expect(computeChange(500, 0).type).toBe("new");
  });
  it("returns zero when both are 0", () => {
    expect(computeChange(0, 0).type).toBe("zero");
  });
  it("returns positive pct when current > prev", () => {
    const c = computeChange(120, 100);
    expect(c.type).toBe("pct");
    if (c.type === "pct") expect(c.value).toBeCloseTo(20);
  });
  it("returns negative pct when current < prev", () => {
    const c = computeChange(80, 100);
    expect(c.type).toBe("pct");
    if (c.type === "pct") expect(c.value).toBeCloseTo(-20);
  });
  it("returns zero when both are zero", () => {
    expect(computeChange(0, 0).type).toBe("zero");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCategoryBreakdown
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCategoryBreakdown", () => {
  it("sums amounts per category and sorts descending", () => {
    const rows = [
      row({ category: "Travel", total_amount: 3000 }),
      row({ category: "Food", total_amount: 1000 }),
      row({ category: "Travel", total_amount: 1000 }),
    ];
    const result = buildCategoryBreakdown(rows);
    expect(result[0]?.category).toBe("Travel");
    expect(result[0]?.amount).toBe(4000);
  });

  it("computes percentage correctly", () => {
    const rows = [
      row({ category: "A", total_amount: 600 }),
      row({ category: "B", total_amount: 400 }),
    ];
    const result = buildCategoryBreakdown(rows);
    const a = result.find((r) => r.category === "A");
    expect(a?.pct).toBeCloseTo(60);
  });

  it("groups excess categories as Other categories", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ category: `Cat${i}`, total_amount: 100 }),
    );
    const result = buildCategoryBreakdown(rows);
    const other = result.find((r) => r.category === "Other categories");
    expect(other).toBeTruthy();
  });

  it("handles null category as Uncategorized", () => {
    const rows = [row({ category: null, total_amount: 500 })];
    const result = buildCategoryBreakdown(rows);
    expect(result[0]?.category).toBe("Uncategorized");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildStatusBreakdown
// ─────────────────────────────────────────────────────────────────────────────

describe("buildStatusBreakdown", () => {
  it("includes all statuses present in expenses", () => {
    const rows = [
      row({ status: "approved", total_amount: 1000 }),
      row({ status: "submitted", total_amount: 500 }),
    ];
    const result = buildStatusBreakdown(rows);
    expect(result.find((r) => r.status === "approved")).toBeTruthy();
    expect(result.find((r) => r.status === "submitted")).toBeTruthy();
  });

  it("sorts by status order", () => {
    const rows = [
      row({ status: "approved" }),
      row({ status: "submitted" }),
    ];
    const result = buildStatusBreakdown(rows);
    expect(result[0]?.status).toBe("submitted");
  });

  it("computes pct out of total count", () => {
    const rows = [
      row({ status: "approved", total_amount: 1000 }),
      row({ status: "rejected", total_amount: 500 }),
    ];
    const result = buildStatusBreakdown(rows);
    const approved = result.find((r) => r.status === "approved");
    expect(approved?.pct).toBeCloseTo(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDestinationBreakdown
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDestinationBreakdown", () => {
  it("groups by destination and sorts by amount descending", () => {
    const rows = [
      row({ destination: "Delhi", total_amount: 1000 }),
      row({ destination: "Mumbai", total_amount: 5000 }),
      row({ destination: "Delhi", total_amount: 500 }),
    ];
    const result = buildDestinationBreakdown(rows);
    expect(result[0]?.destination).toBe("Mumbai");
    expect(result[0]?.amount).toBe(5000);
    expect(result[1]?.destination).toBe("Delhi");
    expect(result[1]?.amount).toBe(1500);
  });

  it("replaces blank destination with Unspecified", () => {
    const rows = [row({ destination: null, total_amount: 500 })];
    const result = buildDestinationBreakdown(rows);
    expect(result[0]?.destination).toBe("Unspecified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildEmployeeBreakdown
// ─────────────────────────────────────────────────────────────────────────────

describe("buildEmployeeBreakdown", () => {
  it("aggregates by user_id", () => {
    const rows = [
      row({ user_id: "u1", total_amount: 1000 }),
      row({ user_id: "u1", total_amount: 2000 }),
      row({ user_id: "u2", total_amount: 500 }),
    ];
    const profiles: AnalyticsProfile[] = [
      { user_id: "u1", name: "Alice" },
      { user_id: "u2", name: "Bob" },
    ];
    const result = buildEmployeeBreakdown(rows, profiles);
    expect(result[0]?.user_id).toBe("u1");
    expect(result[0]?.totalAmount).toBe(3000);
    expect(result[0]?.count).toBe(2);
  });

  it("uses 'Unknown' as name fallback when no profile", () => {
    const rows = [row({ user_id: "u99", total_amount: 100 })];
    const result = buildEmployeeBreakdown(rows, []);
    expect(result[0]?.name).toBe("Unknown");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPendingAging
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPendingAging", () => {
  it("only includes pending expenses", () => {
    const now = new Date("2024-03-20T00:00:00Z");
    const rows = [
      row({ status: "approved", created_at: "2024-03-01T00:00:00Z" }),
      row({ status: "submitted", created_at: "2024-03-18T00:00:00Z" }),
    ];
    const result = buildPendingAging(rows, now);
    const total = result.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(1);
  });

  it("places expense in correct age bucket", () => {
    const now = new Date("2024-03-20T00:00:00Z");
    // 10 days old → 8-14 bucket
    const rows = [row({ status: "submitted", created_at: "2024-03-10T00:00:00Z" })];
    const result = buildPendingAging(rows, now);
    const bucket = result.find((b) => b.minDays === 8);
    expect(bucket?.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildAmountHistogram
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAmountHistogram", () => {
  it("places amounts in correct buckets", () => {
    const rows = [
      row({ total_amount: 300 }),   // "Under ₹500" bucket (min: 0)
      row({ total_amount: 5000 }),  // "₹5,000–₹9,999" bucket (min: 5000)
    ];
    const result = buildAmountHistogram(rows);
    const lowBucket = result.find((b) => b.min === 0);
    const midBucket = result.find((b) => b.min === 5000);
    expect(lowBucket?.count).toBe(1);
    expect(midBucket?.count).toBe(1);
  });

  it("returns all 6 buckets", () => {
    expect(buildAmountHistogram([]).length).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildWeekdayBreakdown
// ─────────────────────────────────────────────────────────────────────────────

describe("buildWeekdayBreakdown", () => {
  it("returns 7 entries (Mon-Sun)", () => {
    expect(buildWeekdayBreakdown([], "expense_date").length).toBe(7);
  });

  it("increments correct weekday bucket", () => {
    // 2024-03-18 is a Monday
    const rows = [row({ trip_start: "2024-03-18T00:00:00Z", total_amount: 1000 })];
    const result = buildWeekdayBreakdown(rows, "expense_date");
    expect(result[0]?.dayIndex).toBe(0); // Monday = 0
    expect(result[0]?.amount).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildCumulativeSpend
// ─────────────────────────────────────────────────────────────────────────────

describe("buildCumulativeSpend", () => {
  it("cumulates amounts across buckets", () => {
    const trend = [
      { key: "2024-03-01", label: "01/03", amount: 1000, count: 1 },
      { key: "2024-03-02", label: "02/03", amount: 2000, count: 1 },
      { key: "2024-03-03", label: "03/03", amount: 500, count: 1 },
    ];
    const result = buildCumulativeSpend(trend);
    expect(result[0]?.cumulative).toBe(1000);
    expect(result[1]?.cumulative).toBe(3000);
    expect(result[2]?.cumulative).toBe(3500);
  });

  it("handles empty trend", () => {
    expect(buildCumulativeSpend([])).toEqual([]);
  });
});
