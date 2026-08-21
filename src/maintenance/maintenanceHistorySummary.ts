/**
 * Pure summary-metrics computation for the History tab's summary cards and
 * chart. Operates only on rows already fetched by the caller (which must
 * come from readMaintenanceHistory — i.e. already RLS-authorized) — this
 * module does no I/O itself.
 */
import type { MaintenanceHistoryRow } from "@/integrations/maintenance-cloud/types";
import { deriveMaintenanceHistoryStatus, maintenanceHistoryDurationMs } from "./maintenanceHistoryDerivedStatus";

export type MaintenanceHistorySummary = {
  totalOccurrences: number;
  totalDowntimeMs: number;
  averageDurationMs: number | null;
  scheduledCount: number;
  forcedCount: number;
  lastOccurrence: MaintenanceHistoryRow | null;
};

export function summarizeMaintenanceHistory(
  rows: MaintenanceHistoryRow[],
  now: Date = new Date(),
): MaintenanceHistorySummary {
  let totalDowntimeMs = 0;
  let countedDurations = 0;
  let scheduledCount = 0;
  let forcedCount = 0;
  let lastOccurrence: MaintenanceHistoryRow | null = null;
  let lastOccurrenceMs = -Infinity;

  for (const row of rows) {
    if (row.kind === "scheduled") scheduledCount += 1;
    else forcedCount += 1;

    const durationMs = maintenanceHistoryDurationMs(row, now);
    // Cancelled occurrences already return null duration (never downtime).
    if (durationMs !== null) {
      totalDowntimeMs += durationMs;
      countedDurations += 1;
    }

    const anchorMs = new Date(
      row.actual_started_at ?? row.scheduled_start_at ?? row.created_at,
    ).getTime();
    if (Number.isFinite(anchorMs) && anchorMs > lastOccurrenceMs) {
      lastOccurrenceMs = anchorMs;
      lastOccurrence = row;
    }
  }

  return {
    totalOccurrences: rows.length,
    totalDowntimeMs,
    averageDurationMs: countedDurations > 0 ? totalDowntimeMs / countedDurations : null,
    scheduledCount,
    forcedCount,
    lastOccurrence,
  };
}

export type MonthlyDowntimeBucket = {
  /** "YYYY-MM" */
  monthKey: string;
  label: string;
  scheduledMs: number;
  forcedMs: number;
};

/** Downtime minutes grouped by calendar month (local time), for the last
 * `monthsBack` months including the current one, oldest first. Months with
 * zero downtime still appear (with zero values) so the chart's x-axis
 * doesn't silently skip quiet months. */
export function bucketMaintenanceHistoryByMonth(
  rows: MaintenanceHistoryRow[],
  now: Date = new Date(),
  monthsBack = 6,
): MonthlyDowntimeBucket[] {
  const buckets: MonthlyDowntimeBucket[] = [];
  const bucketByKey = new Map<string, MonthlyDowntimeBucket>();

  for (let i = monthsBack - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    const bucket: MonthlyDowntimeBucket = { monthKey, label, scheduledMs: 0, forcedMs: 0 };
    buckets.push(bucket);
    bucketByKey.set(monthKey, bucket);
  }

  for (const row of rows) {
    const durationMs = maintenanceHistoryDurationMs(row, now);
    if (durationMs === null || durationMs === 0) continue;

    const anchor = new Date(row.actual_started_at ?? row.scheduled_start_at ?? row.created_at);
    if (isNaN(anchor.getTime())) continue;
    const monthKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, "0")}`;
    const bucket = bucketByKey.get(monthKey);
    if (!bucket) continue; // outside the requested window

    if (row.kind === "scheduled") bucket.scheduledMs += durationMs;
    else bucket.forcedMs += durationMs;
  }

  return buckets;
}

// Re-exported for convenience so callers don't need a second import for the
// one derived-status check the History tab's list rendering also needs.
export { deriveMaintenanceHistoryStatus };
