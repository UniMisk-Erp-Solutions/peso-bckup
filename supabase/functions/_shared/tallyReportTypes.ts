export const TALLY_SYNC_REPORT_TYPES = [
  "claim_verification",
  "claim_approval",
  "detailed_expense",
  "daily_project_report",
] as const;

export type TallySyncReportType = (typeof TALLY_SYNC_REPORT_TYPES)[number];
