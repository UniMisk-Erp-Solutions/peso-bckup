/**
 * Regression tests (T65–T70): confirm no breakage from the workstream changes.
 */

import { describe, it, expect } from "vitest";
import {
  parseManualTimeInput,
  formatCanonicalTimeForDisplay,
  combineLocalDateAndTimeToUtcIso,
  utcIsoToLocalDateAndTime,
  formatMaintenanceLocalDateTime,
  validateLocalDateTimeParts,
  calculateMaintenanceDuration,
} from "../maintenanceDateTime";

// T65: Re-export surface is intact — all expected functions are importable
it("T65: all expected maintenanceDateTime exports are present", () => {
  expect(typeof parseManualTimeInput).toBe("function");
  expect(typeof formatCanonicalTimeForDisplay).toBe("function");
  expect(typeof combineLocalDateAndTimeToUtcIso).toBe("function");
  expect(typeof utcIsoToLocalDateAndTime).toBe("function");
  expect(typeof formatMaintenanceLocalDateTime).toBe("function");
  expect(typeof validateLocalDateTimeParts).toBe("function");
  expect(typeof calculateMaintenanceDuration).toBe("function");
});

// T66: combineLocalDateAndTimeToUtcIso still works as before
it("T66: combineLocalDateAndTimeToUtcIso returns null for empty inputs (regression)", () => {
  expect(combineLocalDateAndTimeToUtcIso({ date: "", time: "" })).toBeNull();
  expect(combineLocalDateAndTimeToUtcIso({ date: "2099-01-01", time: "" })).toBeNull();
});

// T67: utcIsoToLocalDateAndTime round-trip regression
it("T67: utcIsoToLocalDateAndTime returns date and time strings", () => {
  const iso = "2099-06-15T10:00:00.000Z";
  const parts = utcIsoToLocalDateAndTime(iso);
  expect(parts.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(parts.time).toMatch(/^\d{2}:\d{2}$/);
});

// T68: validateLocalDateTimeParts didn't change its contract
it("T68: validateLocalDateTimeParts returns ok for complete valid input", () => {
  const r = validateLocalDateTimeParts({ date: "2099-12-01", time: "09:30" }, "Test");
  expect(r.ok).toBe(true);
});

// T69: calculateMaintenanceDuration zero-duration returns empty (not crash)
it("T69: calculateMaintenanceDuration same start/end returns empty string", () => {
  const iso = "2099-06-01T10:00:00.000Z";
  expect(calculateMaintenanceDuration(iso, iso)).toBe("");
});

// T70: parseManualTimeInput doesn't accept random garbage
it("T70: parseManualTimeInput rejects nonsense input (regression)", () => {
  expect(parseManualTimeInput("not a time").ok).toBe(false);
  expect(parseManualTimeInput("abc:def").ok).toBe(false);
  expect(parseManualTimeInput("99:99").ok).toBe(false);
});
