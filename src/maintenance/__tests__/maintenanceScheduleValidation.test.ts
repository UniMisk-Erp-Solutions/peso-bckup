import { describe, it, expect } from "vitest";
import { validateMaintenanceSchedule } from "@/maintenance/maintenanceScheduleValidation";

describe("validateMaintenanceSchedule", () => {
  it("allows both null (no schedule)", () => {
    expect(validateMaintenanceSchedule(null, null)).toEqual({ ok: true });
  });

  it("allows both empty strings (no schedule)", () => {
    expect(validateMaintenanceSchedule("", "")).toEqual({ ok: true });
  });

  it("rejects start without end", () => {
    const result = validateMaintenanceSchedule("2026-09-01T00:00:00Z", null);
    expect(result.ok).toBe(false);
  });

  it("rejects end without start", () => {
    const result = validateMaintenanceSchedule(null, "2026-09-01T00:00:00Z");
    expect(result.ok).toBe(false);
  });

  it("rejects end equal to start", () => {
    const result = validateMaintenanceSchedule(
      "2026-09-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects end before start", () => {
    const result = validateMaintenanceSchedule(
      "2026-09-01T12:00:00Z",
      "2026-09-01T10:00:00Z",
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a valid window", () => {
    const result = validateMaintenanceSchedule(
      "2026-09-01T10:00:00Z",
      "2026-09-01T12:00:00Z",
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects unparseable dates", () => {
    const result = validateMaintenanceSchedule("not-a-date", "also-not-a-date");
    expect(result.ok).toBe(false);
  });
});
