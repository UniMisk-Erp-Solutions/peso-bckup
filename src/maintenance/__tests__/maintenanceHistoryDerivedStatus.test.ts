import { describe, expect, it } from "vitest";
import {
  deriveMaintenanceHistoryStatus,
  maintenanceHistoryDurationMs,
} from "../maintenanceHistoryDerivedStatus";
import type { MaintenanceHistoryRow } from "@/integrations/maintenance-cloud/types";

function baseRow(overrides: Partial<MaintenanceHistoryRow> = {}): MaintenanceHistoryRow {
  return {
    id: "hist-1",
    environment: "preview",
    kind: "scheduled",
    title: null,
    message: null,
    scheduled_start_at: null,
    scheduled_end_at: null,
    actual_started_at: null,
    actual_ended_at: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    created_by: null,
    updated_at: new Date().toISOString(),
    updated_by: null,
    ...overrides,
  };
}

describe("deriveMaintenanceHistoryStatus — scheduled", () => {
  const now = new Date("2026-08-15T12:00:00Z");

  it("Upcoming: now < scheduled_start_at", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T13:00:00Z",
      scheduled_end_at: "2026-08-15T14:00:00Z",
    });
    expect(deriveMaintenanceHistoryStatus(row, now)).toBe("upcoming");
  });

  it("Active: start <= now < end", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T11:00:00Z",
      scheduled_end_at: "2026-08-15T13:00:00Z",
    });
    expect(deriveMaintenanceHistoryStatus(row, now)).toBe("active");
  });

  it("Completed: now >= scheduled_end_at", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T09:00:00Z",
      scheduled_end_at: "2026-08-15T10:00:00Z",
    });
    expect(deriveMaintenanceHistoryStatus(row, now)).toBe("completed");
  });

  it("Cancelled overrides every other state, even mid-window", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T11:00:00Z",
      scheduled_end_at: "2026-08-15T13:00:00Z",
      cancelled_at: "2026-08-15T11:30:00Z",
    });
    expect(deriveMaintenanceHistoryStatus(row, now)).toBe("cancelled");
  });
});

describe("deriveMaintenanceHistoryStatus — forced", () => {
  it("Active: actual_ended_at is null", () => {
    const row = baseRow({ kind: "forced", actual_started_at: "2026-08-15T11:00:00Z" });
    expect(deriveMaintenanceHistoryStatus(row)).toBe("active");
  });

  it("Completed: actual_ended_at is set", () => {
    const row = baseRow({
      kind: "forced",
      actual_started_at: "2026-08-15T11:00:00Z",
      actual_ended_at: "2026-08-15T11:30:00Z",
    });
    expect(deriveMaintenanceHistoryStatus(row)).toBe("completed");
  });
});

describe("maintenanceHistoryDurationMs", () => {
  const now = new Date("2026-08-15T12:00:00Z");

  it("cancelled schedules never count as downtime", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T11:00:00Z",
      scheduled_end_at: "2026-08-15T13:00:00Z",
      cancelled_at: "2026-08-15T11:30:00Z",
    });
    expect(maintenanceHistoryDurationMs(row, now)).toBeNull();
  });

  it("upcoming schedules have no duration yet", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T13:00:00Z",
      scheduled_end_at: "2026-08-15T14:00:00Z",
    });
    expect(maintenanceHistoryDurationMs(row, now)).toBeNull();
  });

  it("completed schedule duration is the full configured window", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T09:00:00Z",
      scheduled_end_at: "2026-08-15T10:30:00Z",
    });
    expect(maintenanceHistoryDurationMs(row, now)).toBe(90 * 60_000);
  });

  it("active schedule duration is elapsed-so-far (now - start)", () => {
    const row = baseRow({
      scheduled_start_at: "2026-08-15T11:00:00Z",
      scheduled_end_at: "2026-08-15T13:00:00Z",
    });
    expect(maintenanceHistoryDurationMs(row, now)).toBe(60 * 60_000);
  });

  it("active forced duration is now - actual_started_at (still running)", () => {
    const row = baseRow({ kind: "forced", actual_started_at: "2026-08-15T11:15:00Z" });
    expect(maintenanceHistoryDurationMs(row, now)).toBe(45 * 60_000);
  });

  it("completed forced duration is actual_ended_at - actual_started_at", () => {
    const row = baseRow({
      kind: "forced",
      actual_started_at: "2026-08-15T10:00:00Z",
      actual_ended_at: "2026-08-15T10:20:00Z",
    });
    expect(maintenanceHistoryDurationMs(row, now)).toBe(20 * 60_000);
  });
});
