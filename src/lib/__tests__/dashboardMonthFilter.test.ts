/**
 * Dashboard Month filter (get_dashboard_stats_v2): month scope, option list,
 * cache identity, stale-request guard, and the migration/page contracts.
 *
 * The SQL itself is proven against real Production data in a rolled-back
 * transaction (see Documentations MD/dashboard-month-filter.md §Verification);
 * these tests pin the pure logic and the contracts that must not silently drift.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  dashboardMonthRpcBounds,
  parseDashboardStatsV2,
} from "../dashboardStats";
import {
  buildDashboardMonthOptions,
  currentDashboardMonth,
  formatBalanceAsOfDate,
} from "../dashboardMonthScope";
import { dashboardStatsCacheKey, readDashboardStatsCache, writeDashboardStatsCache } from "../dashboardStatsCache";
import { createMonthFetchGuardState, invalidateMonthFetch, runMonthFetch } from "../monthFetchGuard";

const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), "g");
const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20261003000000_dashboard_stats_month_v2.sql"),
  "utf-8",
).replace(CRLF, String.fromCharCode(10));
const page = readFileSync(resolve(process.cwd(), "src/pages/Dashboard.tsx"), "utf-8").replace(CRLF, String.fromCharCode(10));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("dashboardMonthRpcBounds -- half-open calendar month on trip_start", () => {
  it("All time sends no bounds at all (today's behaviour exactly)", () => {
    expect(dashboardMonthRpcBounds("all")).toEqual({ p_month_from: null, p_month_to_exclusive: null });
  });
  it("August 2026 = [2026-08-01, 2026-09-01)", () => {
    expect(dashboardMonthRpcBounds("2026-08")).toEqual({ p_month_from: "2026-08-01", p_month_to_exclusive: "2026-09-01" });
  });
  it("September 2026 = [2026-09-01, 2026-10-01)", () => {
    expect(dashboardMonthRpcBounds("2026-09")).toEqual({ p_month_from: "2026-09-01", p_month_to_exclusive: "2026-10-01" });
  });
  it("December rolls into January of the next year", () => {
    expect(dashboardMonthRpcBounds("2025-12")).toEqual({ p_month_from: "2025-12-01", p_month_to_exclusive: "2026-01-01" });
  });
  it("leap February 2024 ends before 2024-03-01; non-leap 2026 the same rule", () => {
    expect(dashboardMonthRpcBounds("2024-02").p_month_to_exclusive).toBe("2024-03-01");
    expect(dashboardMonthRpcBounds("2026-02").p_month_to_exclusive).toBe("2026-03-01");
  });
});

describe("parseDashboardStatsV2", () => {
  const admin = {
    total_amount: "5628520.78", expense_count: 23780, pending_amount: 100, approved_amount: 50,
    pending_approvals: 3, pending_approvals_amount: 30, pending_reviews: null, pending_reviews_amount: null,
    current_balance: -517, role_balance_totals: { employee: -1, engineer: 2, cashier: 3 },
    scope: { role: "admin", month_from: "2026-08-01", month_to_exclusive: "2026-09-01", balance_basis: "month_end", balance_as_of: "2026-08-31" },
  };
  it("maps every field, keeping null review numbers null for non-engineers", () => {
    const p = parseDashboardStatsV2(admin)!;
    expect(p.totalAmount).toBe(5628520.78);
    expect(p.pendingReviews).toBeNull();
    expect(p.roleBalanceTotals).toEqual({ employee: -1, engineer: 2, cashier: 3 });
    expect(p.balanceBasis).toBe("month_end");
    expect(p.balanceAsOf).toBe("2026-08-31");
  });
  it("defaults to a LIVE balance when scope says live / is missing", () => {
    expect(parseDashboardStatsV2({ ...admin, scope: { balance_basis: "live", balance_as_of: null } })!.balanceBasis).toBe("live");
    expect(parseDashboardStatsV2({ ...admin, scope: undefined })!.balanceBasis).toBe("live");
  });
  it("rejects payloads that are not a stats object", () => {
    expect(parseDashboardStatsV2(null)).toBeNull();
    expect(parseDashboardStatsV2({})).toBeNull();
  });
});

describe("Dashboard month options", () => {
  const now = new Date("2026-09-25T10:00:00Z");
  it("starts with All time, then the current month newest-first, down to the earliest month", () => {
    const o = buildDashboardMonthOptions({ earliest: "2026-06", now });
    expect(o.map((x) => x.value)).toEqual(["all", "2026-09", "2026-08", "2026-07", "2026-06"]);
    expect(o[0].label).toBe("All time");
    expect(o[2].label).toBe("August 2026"); // friendly, never "2026-08"
  });
  it("never offers a future month", () => {
    const o = buildDashboardMonthOptions({ earliest: "2026-01", now });
    expect(o.some((x) => x.value !== "all" && x.value > "2026-09")).toBe(false);
  });
  it("still includes the current month when there is no expense history", () => {
    const o = buildDashboardMonthOptions({ earliest: null, now });
    expect(o.map((x) => x.value)).toEqual(["all", "2026-09"]);
  });
  it("includes zero-expense months in the range (a balance can exist without expenses)", () => {
    const o = buildDashboardMonthOptions({ earliest: "2026-01", now });
    expect(o).toHaveLength(1 + 9);
  });
  it("uses the server's Asia/Kolkata calendar for 'current month' at a month boundary", () => {
    // 2026-09-30 19:00Z is already 2026-10-01 00:30 in IST.
    const edge = new Date("2026-09-30T19:00:00Z");
    expect(currentDashboardMonth(edge)).toBe("2026-10");
    expect(buildDashboardMonthOptions({ earliest: "2026-09", now: edge }).map((x) => x.value)).toEqual(["all", "2026-10", "2026-09"]);
  });
  it("Dec -> Jan crossing", () => {
    const o = buildDashboardMonthOptions({ earliest: "2025-11", now: new Date("2026-01-15T00:00:00Z") });
    expect(o.map((x) => x.value)).toEqual(["all", "2026-01", "2025-12", "2025-11"]);
  });
});

describe("formatBalanceAsOfDate", () => {
  it("31 Aug 2026 with no timezone shift", () => {
    expect(formatBalanceAsOfDate("2026-08-31")).toBe("31 Aug 2026");
    expect(formatBalanceAsOfDate("2024-02-29")).toBe("29 Feb 2024");
  });
});

describe("dashboard stats cache identity (month + org + user + role)", () => {
  beforeEach(() => localStorage.clear());
  const base = ["u1", "admin", "org1"] as const;
  it("defaults to the all-time key and is versioned past v1", () => {
    expect(dashboardStatsCacheKey(...base)).toBe(dashboardStatsCacheKey(...base, "all"));
    expect(dashboardStatsCacheKey(...base)).toContain("stats-v2");
  });
  it("August and September never share a key", () => {
    expect(dashboardStatsCacheKey(...base, "2026-08")).not.toBe(dashboardStatsCacheKey(...base, "2026-09"));
    expect(dashboardStatsCacheKey(...base, "2026-08")).not.toBe(dashboardStatsCacheKey(...base));
  });
  it("different org / user / role never share a key", () => {
    const k = dashboardStatsCacheKey(...base, "2026-08");
    expect(dashboardStatsCacheKey("u1", "admin", "org2", "2026-08")).not.toBe(k);
    expect(dashboardStatsCacheKey("u2", "admin", "org1", "2026-08")).not.toBe(k);
    expect(dashboardStatsCacheKey("u1", "employee", "org1", "2026-08")).not.toBe(k);
  });
  it("an August snapshot is never returned for September or All time", () => {
    const snap = { totalExpenses: 1, pendingAmount: 2, approvedAmount: 3, currentBalance: 4, balanceBasis: "month_end" as const, balanceAsOf: "2026-08-31" };
    writeDashboardStatsCache(dashboardStatsCacheKey(...base, "2026-08"), snap);
    expect(readDashboardStatsCache(dashboardStatsCacheKey(...base, "2026-08"))?.balanceAsOf).toBe("2026-08-31");
    expect(readDashboardStatsCache(dashboardStatsCacheKey(...base, "2026-09"))).toBeNull();
    expect(readDashboardStatsCache(dashboardStatsCacheKey(...base))).toBeNull();
  });
  it("an old v1 entry (no month segment) is never read as month-scoped state", () => {
    localStorage.setItem("pesowise-dashboard-stats-v1:u1:admin:org1", JSON.stringify({ totalExpenses: 9, cachedAt: Date.now() }));
    expect(readDashboardStatsCache(dashboardStatsCacheKey(...base))).toBeNull();
    expect(readDashboardStatsCache(dashboardStatsCacheKey(...base, "2026-08"))).toBeNull();
  });
});

describe("stale response guard -- August cannot overwrite September", () => {
  it("a slow August response arriving after September is dropped", async () => {
    const state = createMonthFetchGuardState();
    let selected = "2026-08";
    const august = deferred<string>();
    const september = deferred<string>();

    const pAug = runMonthFetch(state, () => selected === "2026-08", () => august.promise);
    selected = "2026-09";
    const pSep = runMonthFetch(state, () => selected === "2026-09", () => september.promise);

    september.resolve("SEPTEMBER");
    august.resolve("AUGUST"); // slow one lands last
    expect(await pSep).toEqual({ kind: "success", data: "SEPTEMBER" });
    expect((await pAug).kind).not.toBe("success");
  });
  it("switching org/user (invalidate) drops an in-flight month response", async () => {
    const state = createMonthFetchGuardState();
    const d = deferred<string>();
    const p = runMonthFetch(state, () => true, () => d.promise);
    invalidateMonthFetch(state);
    d.resolve("OLD ORG");
    expect((await p).kind).not.toBe("success");
  });
});

describe("migration contract: get_dashboard_stats_v2", () => {
  it("takes identity from auth.uid(), never a user argument", () => {
    expect(migration).toMatch(/v_uid\s+uuid := auth\.uid\(\)/);
    expect(migration).not.toMatch(/p_user_idb/);
  });
  it("requires an ACTIVE membership of the requested organization", () => {
    expect(migration).toMatch(/m\.is_active = true/);
    expect(migration).toMatch(/not an active member of this organization/);
  });
  it("is additive: anon has no EXECUTE, PUBLIC revoked, authenticated granted", () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.get_dashboard_stats_v2\(uuid, date, date\) FROM PUBLIC/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.get_dashboard_stats_v2\(uuid, date, date\) FROM anon/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_dashboard_stats_v2\(uuid, date, date\) TO authenticated/);
  });
  it("has a safe search_path and does not touch the legacy RPCs", () => {
    expect(migration).toMatch(/SET search_path = public/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_dashboard_expense_summary/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_org_role_balance_totals/);
  });
  it("month scope is half-open on trip_start (never created_at/approved_at)", () => {
    expect(migration).toMatch(/e\.trip_start >= p_month_from AND e\.trip_start < p_month_to_exclusive/);
    expect(migration).not.toMatch(/created_at\s*[<>]=?\s*p_month/);
  });
  it("only an exact calendar month is accepted", () => {
    expect(migration).toMatch(/bounds must be an exact calendar month/);
    expect(migration).toMatch(/month bounds must be supplied together/);
  });
  it("Current Balance is point-in-time: live for All time / unfinished months, canonical event model otherwise", () => {
    expect(migration).toMatch(/v_live := \(NOT v_scoped\) OR \(p_month_to_exclusive > v_today\)/);
    expect(migration).toMatch(/_dashboard_balances_as_of_v1\(p_organization_id, ARRAY\[v_uid\], p_month_to_exclusive\)/);
    // never "current balance minus month's expenses"
    expect(migration).not.toMatch(/balance\s*-\s*v_total/i);
  });
  it("month-end balances reuse the SAME canonical sources as Detailed Expense V4", () => {
    expect(migration).toMatch(/_balance_timeline_events_v3\(p_organization_id, p_user_ids\)/);
    expect(migration).toMatch(/report_historical_reconciliation_events/);
    expect(migration).toMatch(/'historical_opening_balance'|historical opening|opening AS/i);
    expect(migration).toMatch(/e\.status = 'approved'/);
    expect(migration).toMatch(/\(-e\.total_amount\)/);
  });
  it("the balance helper is not client-callable", () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\._dashboard_balances_as_of_v1\(uuid, uuid\[\], date\) FROM anon, authenticated/);
  });
  it("engineer pending is month-scoped by trip_start on BOTH paths", () => {
    const eng = migration.slice(migration.indexOf("Engineer pending reviews"), migration.indexOf("Balances (point-in-time)"));
    expect(eng.match(/e\.trip_start >= p_month_from/g)?.length).toBe(2);
  });
});

describe("Dashboard page contract", () => {
  it("defaults to All time and resets on user/role/org change", () => {
    expect(page).toMatch(/useState<ExpenseMonthValue>\(ALL_MONTHS\)/);
    expect(page).toMatch(/\}, \[user\?\.id, userRole, organizationId\]\);/);
    expect(page).toMatch(/selectedMonthRef\.current = ALL_MONTHS;/);
  });
  it("fetchStats reads the CURRENT month from a ref, so realtime refreshes preserve it", () => {
    const fn = page.slice(page.indexOf("const fetchStats = async"), page.indexOf("const handleMonthChange"));
    expect(fn).toMatch(/const month = selectedMonthRef\.current;/);
    expect(fn).toMatch(/runMonthFetch<DashboardStats>/);
    expect(fn).toMatch(/fetchDashboardStatsV2\(orgId, month, signal\)/);
    // a month can never fall back to the legacy (all-time only) path
    expect(fn).toMatch(/if \(month !== ALL_MONTHS \|\| signal\?\.aborted\) throw error;/);
    // realtime/notification refreshes call the same fetchStats (no separate all-time call)
    expect(page.match(/fetchDashboardExpenseSummary\(/g)?.length).toBe(1);
  });
  it("cache is read and written under a key that includes the month", () => {
    expect(page).toMatch(/dashboardStatsCacheKey\(userId, userRole, orgId, month\)/);
    expect(page).toMatch(/dashboardStatsCacheKey\(user\.id, userRole, organizationId, selectedMonthRef\.current\)/);
  });
  it("the selector sits ABOVE the stats grid, one combined Month control", () => {
    const sel = page.indexOf('data-testid="dashboard-month-filter"');
    const grid = page.indexOf("{/* Mobile-optimized Stats Grid */}");
    expect(sel).toBeGreaterThan(0);
    expect(sel).toBeLessThan(grid);
    expect(page.match(/<SelectTrigger\s+id="dashboard-month-select"/g)?.length).toBe(1);
    expect(page).not.toMatch(/dashboard-year-select/);
  });
  it("selector is mobile-safe (full width on phones) and theme-token based for dark mode", () => {
    const block = page.slice(page.indexOf("{/* Dashboard period"), page.indexOf("{/* Mobile-optimized Stats Grid */}"));
    expect(block).toMatch(/w-full sm:w-\[200px\]/);
    expect(block).toMatch(/flex-col gap-2 sm:flex-row/);
    expect(block).not.toMatch(/bg-white|text-gray-|text-black|#[0-9a-fA-F]{3,6}/);
    expect(block).toMatch(/text-muted-foreground/);
  });
  it("month-end balance does not get replaced by the live auth-context balance", () => {
    expect(page).toMatch(/balanceIsMonthEnd \|\| userRole === "admin"/);
  });
  it("labels: Balance as of <date>, Pending in <month>, Showing <month>", () => {
    expect(page).toMatch(/monthCards\.balanceAsOf/);
    expect(page).toMatch(/monthCards\.pendingIn/);
    expect(page).toMatch(/monthFilter\.showing"/);
  });
  it("cards keep their values while a new month loads (dimmed, not zeroed)", () => {
    expect(page).toMatch(/statsRefreshing && selectedMonth !== displayedMonth && "opacity-60"/);
    expect(page).toMatch(/setStats\(outcome\.data\);\s*setDisplayedMonth\(month\);/);
  });
});
