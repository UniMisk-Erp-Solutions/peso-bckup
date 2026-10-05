/** Stale-while-revalidate cache for dashboard stat cards (localStorage). */

export type DashboardStatsSnapshot = {
  totalExpenses: number;
  pendingAmount: number;
  approvedAmount: number;
  currentBalance: number;
  pendingReviews?: number;
  pendingReviewsAmount?: number;
  pendingApprovals?: number;
  pendingApprovalsAmount?: number;
  totalEmployeeBalance?: number;
  totalEngineerBalance?: number;
  totalCashierBalance?: number;
  /** Whether currentBalance is live or a month-end balance (Month filter). */
  balanceBasis?: "live" | "month_end";
  balanceAsOf?: string | null;
};

type CachedPayload = DashboardStatsSnapshot & {
  cachedAt: number;
};

// v2: the key now includes the selected month. v1 entries (All time only, no
// month segment) are simply never read again -- no mixed-scope hydration.
const STORAGE_PREFIX = "pesowise-dashboard-stats-v2";
/** Keep showing cached totals for up to 7 days while refreshing in the background. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function dashboardStatsCacheKey(
  userId: string,
  role: string,
  organizationId: string | null,
  month: string = "all",
): string {
  return `${STORAGE_PREFIX}:${userId}:${role}:${organizationId ?? "none"}:${month}`;
}

export function readDashboardStatsCache(key: string): DashboardStatsSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!parsed?.cachedAt || Date.now() - parsed.cachedAt > MAX_AGE_MS) {
      localStorage.removeItem(key);
      return null;
    }
    const { cachedAt: _cachedAt, ...stats } = parsed;
    return stats;
  } catch {
    return null;
  }
}

export function writeDashboardStatsCache(
  key: string,
  stats: DashboardStatsSnapshot,
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: CachedPayload = { ...stats, cachedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Quota or private mode — ignore.
  }
}
