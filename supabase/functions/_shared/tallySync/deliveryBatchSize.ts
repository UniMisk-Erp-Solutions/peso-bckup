/** Smaller batches for metadata-heavy daily rows (avoids Tally "Unknown Request" on large POST bodies). */
export function deliveryBatchSizeForReport(reportType: string | null | undefined): number {
  if (reportType === "daily_project_report") return 5;
  return 50;
}
