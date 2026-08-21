import { describe, expect, it } from "vitest";
import { summarizeMaintenanceHistory, bucketMaintenanceHistoryByMonth } from "../maintenanceHistorySummary";
import type { MaintenanceHistoryRow } from "@/integrations/maintenance-cloud/types";

function row(overrides: Partial<MaintenanceHistoryRow>): MaintenanceHistoryRow {
  return {
    id: `hist-${Math.random()}`,
    environment: "preview",
    kind: "scheduled",
    title: null,
    message: null,
    scheduled_start_at: null,
    scheduled_end_at: null,
    actual_started_at: null,
    actual_ended_at: null,
    cancelled_at: null,
    created_at: "2026-08-01T00:00:00Z",
    created_by: null,
    updated_at: "2026-08-01T00:00:00Z",
    updated_by: null,
    ...overrides,
  };
}

describe("summarizeMaintenanceHistory", () => {
  const now = new Date("2026-08-15T12:00:00Z");

  it("counts total occurrences and splits scheduled vs forced", () => {
    const rows = [
      row({ kind: "scheduled", scheduled_start_at: "2026-08-01T00:00:00Z", scheduled_end_at: "2026-08-01T01:00:00Z" }),
      row({ kind: "forced", actual_started_at: "2026-08-02T00:00:00Z", actual_ended_at: "2026-08-02T00:30:00Z" }),
      row({ kind: "forced", actual_started_at: "2026-08-03T00:00:00Z", actual_ended_at: "2026-08-03T00:15:00Z" }),
    ];
    const summary = summarizeMaintenanceHistory(rows, now);
    expect(summary.totalOccurrences).toBe(3);
    expect(summary.scheduledCount).toBe(1);
    expect(summary.forcedCount).toBe(2);
  });

  it("sums total downtime and excludes cancelled occurrences", () => {
    const rows = [
      row({ kind: "scheduled", scheduled_start_at: "2026-08-01T00:00:00Z", scheduled_end_at: "2026-08-01T01:00:00Z" }), // 60m
      row({
        kind: "scheduled",
        scheduled_start_at: "2026-08-02T00:00:00Z",
        scheduled_end_at: "2026-08-02T02:00:00Z",
        cancelled_at: "2026-08-02T00:10:00Z",
      }), // cancelled — must not count
      row({ kind: "forced", actual_started_at: "2026-08-03T00:00:00Z", actual_ended_at: "2026-08-03T00:30:00Z" }), // 30m
    ];
    const summary = summarizeMaintenanceHistory(rows, now);
    expect(summary.totalDowntimeMs).toBe(90 * 60_000);
    expect(summary.averageDurationMs).toBe(45 * 60_000);
  });

  it("returns null average when no occurrence has a countable duration", () => {
    const rows = [row({ scheduled_start_at: "2026-08-20T00:00:00Z", scheduled_end_at: "2026-08-20T01:00:00Z" })]; // upcoming, no duration yet
    const summary = summarizeMaintenanceHistory(rows, now);
    expect(summary.averageDurationMs).toBeNull();
  });

  it("identifies the most recent occurrence by its start time", () => {
    const older = row({ id: "older", actual_started_at: "2026-08-01T00:00:00Z" });
    const newer = row({ id: "newer", actual_started_at: "2026-08-10T00:00:00Z" });
    const summary = summarizeMaintenanceHistory([older, newer], now);
    expect(summary.lastOccurrence?.id).toBe("newer");
  });

  it("handles an empty list without error", () => {
    const summary = summarizeMaintenanceHistory([], now);
    expect(summary).toEqual({
      totalOccurrences: 0,
      totalDowntimeMs: 0,
      averageDurationMs: null,
      scheduledCount: 0,
      forcedCount: 0,
      lastOccurrence: null,
    });
  });
});

describe("bucketMaintenanceHistoryByMonth", () => {
  it("returns exactly monthsBack buckets, oldest first, including zero months", () => {
    const now = new Date(2026, 7, 15); // August 2026, local
    const buckets = bucketMaintenanceHistoryByMonth([], now, 6);
    expect(buckets).toHaveLength(6);
    expect(buckets[5].monthKey).toBe("2026-08");
    expect(buckets[0].monthKey).toBe("2026-03");
    expect(buckets.every((b) => b.scheduledMs === 0 && b.forcedMs === 0)).toBe(true);
  });

  it("groups a scheduled occurrence's duration into its own month", () => {
    const now = new Date(2026, 7, 15);
    const rows = [
      row({
        kind: "scheduled",
        scheduled_start_at: new Date(2026, 6, 10, 10, 0).toISOString(),
        scheduled_end_at: new Date(2026, 6, 10, 11, 0).toISOString(),
      }),
    ];
    const buckets = bucketMaintenanceHistoryByMonth(rows, now, 6);
    const julyBucket = buckets.find((b) => b.monthKey === "2026-07");
    expect(julyBucket?.scheduledMs).toBe(60 * 60_000);
    expect(julyBucket?.forcedMs).toBe(0);
  });

  it("ignores occurrences outside the requested window", () => {
    const now = new Date(2026, 7, 15);
    const rows = [
      row({
        kind: "scheduled",
        scheduled_start_at: new Date(2025, 0, 1, 10, 0).toISOString(),
        scheduled_end_at: new Date(2025, 0, 1, 11, 0).toISOString(),
      }),
    ];
    const buckets = bucketMaintenanceHistoryByMonth(rows, now, 6);
    expect(buckets.reduce((sum, b) => sum + b.scheduledMs + b.forcedMs, 0)).toBe(0);
  });
});
