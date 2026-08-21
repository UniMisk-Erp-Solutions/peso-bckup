/**
 * DD/MM/YYYY maintenance display formatters — owner-requested global format.
 * See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §35.
 *
 * Inputs are constructed via the LOCAL Date constructor (not hand-crafted
 * UTC ISO strings) so these tests are deterministic regardless of the test
 * runner's timezone — round-tripping local-constructed-Date -> toISOString()
 * -> formatMaintenanceDate() always recovers the original local day/month/year.
 */
import { describe, expect, it } from "vitest";
import {
  formatMaintenanceDate,
  formatMaintenanceTime,
  formatMaintenanceDateTime,
  formatMaintenanceCountdown,
} from "../maintenanceDateTime";

describe("formatMaintenanceDate — DD/MM/YYYY", () => {
  it("formats 01/01/2026", () => {
    expect(formatMaintenanceDate(new Date(2026, 0, 1, 10, 0).toISOString())).toBe("01/01/2026");
  });

  it("formats 09/08/2026", () => {
    expect(formatMaintenanceDate(new Date(2026, 7, 9, 10, 0).toISOString())).toBe("09/08/2026");
  });

  it("formats 31/12/2026", () => {
    expect(formatMaintenanceDate(new Date(2026, 11, 31, 10, 0).toISOString())).toBe("31/12/2026");
  });

  it("returns empty string for null/undefined/invalid input", () => {
    expect(formatMaintenanceDate(null)).toBe("");
    expect(formatMaintenanceDate(undefined)).toBe("");
    expect(formatMaintenanceDate("not-a-date")).toBe("");
  });
});

describe("formatMaintenanceTime — 12-hour clock", () => {
  it("formats an afternoon time with PM", () => {
    expect(formatMaintenanceTime(new Date(2026, 7, 15, 17, 30).toISOString())).toBe("5:30 PM");
  });

  it("formats midnight as 12:00 AM", () => {
    expect(formatMaintenanceTime(new Date(2026, 7, 15, 0, 0).toISOString())).toBe("12:00 AM");
  });

  it("formats noon as 12:00 PM", () => {
    expect(formatMaintenanceTime(new Date(2026, 7, 15, 12, 0).toISOString())).toBe("12:00 PM");
  });

  it("pads single-digit minutes", () => {
    expect(formatMaintenanceTime(new Date(2026, 7, 15, 9, 5).toISOString())).toBe("9:05 AM");
  });
});

describe("formatMaintenanceDateTime", () => {
  it("combines date and time with a bullet separator", () => {
    expect(formatMaintenanceDateTime(new Date(2026, 7, 15, 17, 30).toISOString())).toBe(
      "15/08/2026 • 5:30 PM",
    );
  });

  it("appends a timezone abbreviation when requested", () => {
    const result = formatMaintenanceDateTime(new Date(2026, 7, 15, 17, 30).toISOString(), {
      withTimezone: true,
    });
    expect(result).toMatch(/^15\/08\/2026 • 5:30 PM( [A-Za-z+\-0-9:]+)?$/);
  });

  it("returns empty string rather than a partial value for invalid input", () => {
    expect(formatMaintenanceDateTime(null)).toBe("");
    expect(formatMaintenanceDateTime("garbage")).toBe("");
  });
});

describe("formatMaintenanceCountdown", () => {
  it("shows minutes only under an hour", () => {
    expect(formatMaintenanceCountdown(45 * 60_000)).toBe("45m");
  });

  it("shows hours only on an exact hour boundary", () => {
    expect(formatMaintenanceCountdown(2 * 3_600_000)).toBe("2h");
  });

  it("shows hours and minutes together", () => {
    expect(formatMaintenanceCountdown(72 * 60_000)).toBe("1h 12m");
  });

  it("clamps a negative duration to 0m rather than showing a negative time", () => {
    expect(formatMaintenanceCountdown(-5_000)).toBe("0m");
  });

  it("rounds down partial minutes", () => {
    expect(formatMaintenanceCountdown(90_000)).toBe("1m");
  });
});
