import { describe, expect, it } from "vitest";
import {
  resolveMaintenanceState,
  isValidMaintenanceEnvironment,
  type MaintenanceReadOutcome,
} from "../maintenanceResolver";
import type { MaintenanceStatusRow } from "@/integrations/maintenance-cloud/types";

const NOW = new Date("2026-08-15T12:00:00.000Z");

function row(overrides: Partial<MaintenanceStatusRow> = {}): MaintenanceStatusRow {
  return {
    environment: "production",
    force_maintenance: false,
    title: null,
    message: null,
    starts_at: null,
    ends_at: null,
    updated_at: NOW.toISOString(),
    updated_by: null,
    ...overrides,
  };
}

describe("resolveMaintenanceState — state machine contract (architecture doc §11)", () => {
  it("row 1: force_maintenance=true -> maintenance/forced", () => {
    const outcome: MaintenanceReadOutcome = { kind: "success", row: row({ force_maintenance: true }) };
    const result = resolveMaintenanceState(outcome, NOW);
    expect(result.state).toBe("maintenance");
    expect(result.state === "maintenance" && result.source).toBe("forced");
  });

  it("row 2: force_maintenance=false, starts_at <= now < ends_at -> maintenance/scheduled", () => {
    const outcome: MaintenanceReadOutcome = {
      kind: "success",
      row: row({
        starts_at: "2026-08-15T11:00:00.000Z",
        ends_at: "2026-08-15T13:00:00.000Z",
      }),
    };
    const result = resolveMaintenanceState(outcome, NOW);
    expect(result.state).toBe("maintenance");
    expect(result.state === "maintenance" && result.source).toBe("scheduled");
  });

  it("row 3: future window -> upcoming", () => {
    const outcome: MaintenanceReadOutcome = {
      kind: "success",
      row: row({
        starts_at: "2026-08-16T00:00:00.000Z",
        ends_at: "2026-08-16T02:00:00.000Z",
      }),
    };
    const result = resolveMaintenanceState(outcome, NOW);
    expect(result.state).toBe("upcoming");
  });

  it("row 4: expired window -> normal", () => {
    const outcome: MaintenanceReadOutcome = {
      kind: "success",
      row: row({
        starts_at: "2026-08-14T00:00:00.000Z",
        ends_at: "2026-08-14T02:00:00.000Z",
      }),
    };
    const result = resolveMaintenanceState(outcome, NOW);
    expect(result.state).toBe("normal");
  });

  it("row 4b: no schedule at all -> normal", () => {
    const outcome: MaintenanceReadOutcome = { kind: "success", row: row() };
    expect(resolveMaintenanceState(outcome, NOW).state).toBe("normal");
  });

  const failureKinds: MaintenanceReadOutcome[] = [
    { kind: "not_configured" },
    { kind: "invalid_environment" },
    { kind: "timeout" },
    { kind: "network_error" },
    { kind: "http_error", status: 503 },
    { kind: "malformed" },
    { kind: "no_rows" },
    { kind: "multiple_rows" },
  ];

  it.each(failureKinds)("rows 5-9: every failure kind ($kind) fails open to normal, row=null", (outcome) => {
    const result = resolveMaintenanceState(outcome, NOW);
    expect(result.state).toBe("normal");
    expect(result.state === "normal" && result.row).toBeNull();
  });

  it("a half-configured window (starts_at set, ends_at null) is never trusted — treated as no schedule", () => {
    const outcome: MaintenanceReadOutcome = {
      kind: "success",
      row: row({ starts_at: "2026-08-16T00:00:00.000Z", ends_at: null }),
    };
    expect(resolveMaintenanceState(outcome, NOW).state).toBe("normal");
  });

  it("an inverted window (ends_at <= starts_at) is never trusted", () => {
    const outcome: MaintenanceReadOutcome = {
      kind: "success",
      row: row({
        starts_at: "2026-08-15T13:00:00.000Z",
        ends_at: "2026-08-15T11:00:00.000Z",
      }),
    };
    expect(resolveMaintenanceState(outcome, NOW).state).toBe("normal");
  });

  it("force_maintenance takes precedence over an expired window", () => {
    const outcome: MaintenanceReadOutcome = {
      kind: "success",
      row: row({
        force_maintenance: true,
        starts_at: "2026-08-01T00:00:00.000Z",
        ends_at: "2026-08-02T00:00:00.000Z",
      }),
    };
    const result = resolveMaintenanceState(outcome, NOW);
    expect(result.state).toBe("maintenance");
    expect(result.state === "maintenance" && result.source).toBe("forced");
  });
});

describe("isValidMaintenanceEnvironment", () => {
  it("accepts exactly 'preview' and 'production'", () => {
    expect(isValidMaintenanceEnvironment("preview")).toBe(true);
    expect(isValidMaintenanceEnvironment("production")).toBe(true);
  });

  it("rejects anything else, including undefined and near-misses", () => {
    expect(isValidMaintenanceEnvironment(undefined)).toBe(false);
    expect(isValidMaintenanceEnvironment("")).toBe(false);
    expect(isValidMaintenanceEnvironment("Production")).toBe(false);
    expect(isValidMaintenanceEnvironment("prod")).toBe(false);
    expect(isValidMaintenanceEnvironment("staging")).toBe(false);
  });
});
