/**
 * Stable, deterministic React Query key builders for expense analytics.
 * All inputs that change results are included; arrays are sorted for stability.
 */

export const analyticsKeys = {
  /** Invalidate all analytics for an org */
  all: (orgId: string) => ["expense-analytics", orgId] as const,

  detail: (
    orgId: string,
    userScopeKey: string,
    dateBasis: string,
    dateFrom: string,
    dateTo: string,
    compareEnabled: boolean,
    granularity: string,
    statuses: string[],
    categories: string[],
    selectedEmployeeId: string,
    selectedDestination: string,
  ) =>
    [
      "expense-analytics",
      orgId,
      userScopeKey,
      dateBasis,
      dateFrom,
      dateTo,
      compareEnabled,
      granularity,
      [...statuses].sort().join(","),
      [...categories].sort().join(","),
      selectedEmployeeId,
      selectedDestination,
    ] as const,
};
