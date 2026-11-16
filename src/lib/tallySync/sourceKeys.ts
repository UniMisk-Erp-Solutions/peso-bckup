import type { TallySyncReportType } from "@/lib/tallyReportTypes";

export function expenseSourceKey(organizationId: string, expenseId: string): string {
  return `${organizationId}:expense:${expenseId}`;
}

export function balanceEventSourceKey(organizationId: string, eventId: string): string {
  return `${organizationId}:balance_event:${eventId}`;
}

export function dailyReportRowSourceKey(
  organizationId: string,
  trackDate: string,
  userId: string,
  projectId: string,
): string {
  return `${organizationId}:daily_row:${trackDate}|${userId}|${projectId}`;
}

export function sourceTypeForReport(reportType: TallySyncReportType): string {
  switch (reportType) {
    case "claim_verification":
    case "claim_approval":
      return "expense";
    case "detailed_expense":
      return "balance_timeline";
    case "daily_project_report":
      return "daily_report_row";
    default:
      return "unknown";
  }
}
