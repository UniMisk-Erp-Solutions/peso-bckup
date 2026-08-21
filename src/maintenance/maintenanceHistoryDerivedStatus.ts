/**
 * Pure derivation of a maintenance_history row's display status and
 * duration. No cron moves a row through states server-side — see
 * infra/maintenance-cloud/migrations/002_add_maintenance_history.sql §14 of
 * the architecture doc. Status is always computed from the row's own
 * timestamps at read time.
 */
import type { MaintenanceHistoryRow } from "@/integrations/maintenance-cloud/types";

export type MaintenanceHistoryDerivedStatus = "upcoming" | "active" | "completed" | "cancelled";

export function deriveMaintenanceHistoryStatus(
  row: MaintenanceHistoryRow,
  now: Date = new Date(),
): MaintenanceHistoryDerivedStatus {
  if (row.cancelled_at) return "cancelled";

  if (row.kind === "forced") {
    return row.actual_ended_at ? "completed" : "active";
  }

  // scheduled
  const nowMs = now.getTime();
  const startMs = row.scheduled_start_at ? new Date(row.scheduled_start_at).getTime() : null;
  const endMs = row.scheduled_end_at ? new Date(row.scheduled_end_at).getTime() : null;

  if (startMs === null || endMs === null) return "completed"; // malformed defensively; never expected
  if (nowMs < startMs) return "upcoming";
  if (nowMs < endMs) return "active";
  return "completed";
}

/** Milliseconds this occurrence has run (or ran) for, or null when it hasn't
 * started yet, or has no way to compute a duration (e.g. a forced
 * occurrence still active has no fixed end — callers wanting a live
 * "running for" figure should pass `now` and read the still-active case
 * themselves via actual_started_at). Cancelled schedules never count as
 * downtime — they return null regardless of how long they were configured
 * for, since nothing was ever actually blocking. */
export function maintenanceHistoryDurationMs(
  row: MaintenanceHistoryRow,
  now: Date = new Date(),
): number | null {
  if (row.cancelled_at) return null;

  if (row.kind === "forced") {
    if (!row.actual_started_at) return null;
    const start = new Date(row.actual_started_at).getTime();
    const end = row.actual_ended_at ? new Date(row.actual_ended_at).getTime() : now.getTime();
    return Math.max(0, end - start);
  }

  // scheduled
  if (!row.scheduled_start_at || !row.scheduled_end_at) return null;
  const status = deriveMaintenanceHistoryStatus(row, now);
  const start = new Date(row.scheduled_start_at).getTime();
  if (status === "upcoming") return null; // hasn't started — nothing to measure yet
  const end = status === "active" ? now.getTime() : new Date(row.scheduled_end_at).getTime();
  return Math.max(0, end - start);
}
