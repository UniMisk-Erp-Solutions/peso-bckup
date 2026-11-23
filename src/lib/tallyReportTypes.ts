/** Canonical Tally sync report types — must match DB CHECK and RPC validation. */
export const TALLY_SYNC_REPORT_TYPES = [
  "claim_verification",
  "claim_approval",
  "detailed_expense",
  "daily_project_report",
] as const;

export type TallySyncReportType = (typeof TALLY_SYNC_REPORT_TYPES)[number];

export function isTallySyncReportType(value: string): value is TallySyncReportType {
  return (TALLY_SYNC_REPORT_TYPES as readonly string[]).includes(value);
}

/** Maps expense export report types to Tally sync types (same strings). */
export type ExpenseReportTypeForTally = Exclude<TallySyncReportType, "daily_project_report">;
