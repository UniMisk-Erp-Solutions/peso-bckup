/**
 * Tests for the new time-picker helpers in maintenanceDateTime.ts
 * Covers the 14 time-parsing + formatting + clock-parts requirements.
 */

import { describe, it, expect } from "vitest";
import {
  parseManualTimeInput,
  formatCanonicalTimeForDisplay,
  normalizeClockTime,
  canonicalTimeToClockParts,
} from "../maintenanceDateTime";

// ── parseManualTimeInput ────────────────────────────────────────────────────

describe("parseManualTimeInput", () => {
  it("T1: parses '3:00 PM'", () => {
    const r = parseManualTimeInput("3:00 PM");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("15:00");
  });

  it("T2: parses '03:00 PM'", () => {
    const r = parseManualTimeInput("03:00 PM");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("15:00");
  });

  it("T3: parses '3 PM'", () => {
    const r = parseManualTimeInput("3 PM");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("15:00");
  });

  it("T4: parses '3:05 pm' (lowercase)", () => {
    const r = parseManualTimeInput("3:05 pm");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("15:05");
  });

  it("T5: parses '15:00'", () => {
    const r = parseManualTimeInput("15:00");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("15:00");
  });

  it("T6: parses '00:00'", () => {
    const r = parseManualTimeInput("00:00");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("00:00");
  });

  it("T7: rejects '25:00'", () => {
    const r = parseManualTimeInput("25:00");
    expect(r.ok).toBe(false);
  });

  it("T8: rejects '13:70'", () => {
    const r = parseManualTimeInput("13:70");
    expect(r.ok).toBe(false);
  });

  it("T9: rejects empty text", () => {
    const r = parseManualTimeInput("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/enter a time/i);
  });

  it("T13: parses 15:30 (five-minute increment)", () => {
    const r = parseManualTimeInput("15:30");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("15:30");
  });

  it("T14: parses non-5-minute value '14:37' as-is (valid, accepted)", () => {
    const r = parseManualTimeInput("14:37");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("14:37");
  });

  it("parses '12:00 PM' correctly (noon)", () => {
    const r = parseManualTimeInput("12:00 PM");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("12:00");
  });

  it("parses '12:00 AM' correctly (midnight)", () => {
    const r = parseManualTimeInput("12:00 AM");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("00:00");
  });

  it("rejects '13:00 PM' (hour out of range for 12-hour)", () => {
    const r = parseManualTimeInput("13:00 PM");
    expect(r.ok).toBe(false);
  });
});

// ── formatCanonicalTimeForDisplay ──────────────────────────────────────────

describe("formatCanonicalTimeForDisplay", () => {
  it("T10: formats '15:00' as '3:00 PM'", () => {
    expect(formatCanonicalTimeForDisplay("15:00")).toBe("3:00 PM");
  });

  it("T11: formats '00:00' as '12:00 AM'", () => {
    expect(formatCanonicalTimeForDisplay("00:00")).toBe("12:00 AM");
  });

  it("formats '12:00' as '12:00 PM'", () => {
    expect(formatCanonicalTimeForDisplay("12:00")).toBe("12:00 PM");
  });

  it("formats '09:05' as '9:05 AM'", () => {
    expect(formatCanonicalTimeForDisplay("09:05")).toBe("9:05 AM");
  });
});

// ── normalizeClockTime + canonicalTimeToClockParts round-trip ──────────────

describe("clock parts round-trip (T12)", () => {
  const cases: Array<[string, number, number, "AM" | "PM"]> = [
    ["00:00", 12, 0, "AM"],
    ["01:30", 1, 30, "AM"],
    ["12:00", 12, 0, "PM"],
    ["13:15", 1, 15, "PM"],
    ["23:55", 11, 55, "PM"],
  ];

  it.each(cases)(
    "canonical '%s' → parts (%s, %s, %s) → back to canonical",
    (canonical, h12, m, p) => {
      const parts = canonicalTimeToClockParts(canonical);
      expect(parts.hour12).toBe(h12);
      expect(parts.minute).toBe(m);
      expect(parts.period).toBe(p);

      const back = normalizeClockTime(parts.hour12, parts.minute, parts.period);
      expect(back).toBe(canonical);
    },
  );
});
