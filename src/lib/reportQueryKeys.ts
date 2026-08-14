/**
 * Stable, deterministic React Query key builders for report queries.
 * Every input that changes report results is included.
 * Organization ID and scope key ensure cache isolation.
 */

export const reportKeys = {
  /** Invalidate all reports for an organization */
  all: (orgId: string) => ["reports", orgId] as const,

  verification: (
    orgId: string,
    scopeKey: string,
    employee: string,
    category: string,
    engineerStatus: string,
  ) =>
    [
      "reports",
      orgId,
      scopeKey,
      "verification",
      employee,
      category,
      engineerStatus,
    ] as const,

  approval: (
    orgId: string,
    scopeKey: string,
    employee: string,
    category: string,
    engineerStatus: string,
  ) =>
    [
      "reports",
      orgId,
      scopeKey,
      "approval",
      employee,
      category,
      engineerStatus,
    ] as const,

  detailed: (
    orgId: string,
    scopeKey: string,
    employee: string,
    category: string,
    year: string,
    month: string,
    week: string,
  ) =>
    [
      "reports",
      orgId,
      scopeKey,
      "detailed",
      employee,
      category,
      year,
      month,
      week,
    ] as const,

  daily: (
    orgId: string,
    scopeKey: string,
    employee: string,
    periodMode: string,
    dateFrom: string,
    dateTo: string,
    configSignature: string,
  ) =>
    [
      "reports",
      orgId,
      scopeKey,
      "daily",
      employee,
      periodMode,
      dateFrom,
      dateTo,
      configSignature,
    ] as const,
};
