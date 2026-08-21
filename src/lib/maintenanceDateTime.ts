/**
 * Pure helpers for maintenance schedule date/time handling.
 *
 * All user-facing times are entered in the browser's local timezone.
 * Conversion to/from UTC uses the browser's own offset so no manual
 * timezone arithmetic is needed. DST transitions are handled by the
 * JS Date constructor and toISOString().
 *
 * IMPORTANT: Do NOT use iso.slice(0, 16) to populate local fields —
 * that would display UTC as if it were local time and shift the clock
 * by the timezone offset. Always use utcIsoToLocalDateAndTime() instead.
 */

export type LocalDateTimeParts = {
  date: string; // "YYYY-MM-DD"
  time: string; // "HH:MM"
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Combine separate local date + time fields into a UTC ISO-8601 string.
 * Returns null when the input is missing or the result is an invalid date.
 */
export function combineLocalDateAndTimeToUtcIso(parts: LocalDateTimeParts): string | null {
  const { date, time } = parts;
  if (!date || !time) return null;
  const localDate = new Date(`${date}T${time}:00`);
  if (isNaN(localDate.getTime())) return null;
  return localDate.toISOString();
}

/**
 * Convert a UTC ISO string back to separate local date and time fields.
 * Uses the browser's local timezone so round-trips are lossless modulo
 * DST ambiguity.
 */
export function utcIsoToLocalDateAndTime(iso: string): LocalDateTimeParts {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: "", time: "" };

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");

  return {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}`,
  };
}

/**
 * Format a UTC ISO string as a human-readable local datetime string.
 * e.g. "Fri, 17 Jul 2026 at 8:00 PM"
 */
export function formatMaintenanceLocalDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Format a UTC ISO string as a short UTC preview, e.g. "2026-07-17T14:30:00Z"
 */
export function formatUtcPreview(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().replace(".000Z", "Z").replace(/\.\d+Z$/, "Z");
  } catch {
    return "";
  }
}

/**
 * Calculate maintenance duration between two UTC ISO strings.
 * Returns a human-readable string like "30 minutes" or "2 hours 15 minutes".
 */
export function calculateMaintenanceDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (isNaN(start) || isNaN(end) || end <= start) return "";
  const diffMs = end - start;
  const totalMin = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${mins} minute${mins !== 1 ? "s" : ""}`;
  if (mins === 0) return `${hours} hour${hours !== 1 ? "s" : ""}`;
  return `${hours} hour${hours !== 1 ? "s" : ""} ${mins} minute${mins !== 1 ? "s" : ""}`;
}

/**
 * Validate individual date+time parts — checks presence and parse validity.
 */
export function validateLocalDateTimeParts(parts: LocalDateTimeParts, label: string): ValidationResult {
  if (!parts.date) return { ok: false, error: `${label} date is required` };
  if (!parts.time) return { ok: false, error: `${label} time is required` };
  const d = new Date(`${parts.date}T${parts.time}:00`);
  if (isNaN(d.getTime())) return { ok: false, error: `${label} is not a valid date and time` };
  return { ok: true };
}

/**
 * Round a Date up to the next 5-minute boundary (or the same time if already on one).
 */
export function roundUpToNext5Minutes(d: Date): Date {
  const ms = d.getTime();
  const five = 5 * 60 * 1000;
  return new Date(Math.ceil(ms / five) * five);
}

/**
 * Get default form values for a new schedule break.
 * announcement = now + 5min boundary
 * start = announce + 30min
 * end = start + 30min
 */
export function getScheduleDefaults(): {
  announce: LocalDateTimeParts;
  start: LocalDateTimeParts;
  end: LocalDateTimeParts;
} {
  const announce = roundUpToNext5Minutes(new Date());
  const start = new Date(announce.getTime() + 30 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    announce: utcIsoToLocalDateAndTime(announce.toISOString()),
    start: utcIsoToLocalDateAndTime(start.toISOString()),
    end: utcIsoToLocalDateAndTime(end.toISOString()),
  };
}

/** Return the IANA timezone name for the browser, e.g. "Asia/Calcutta" */
export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "local";
  }
}

/** Return a short timezone abbreviation, e.g. "IST", "EST" */
export function getBrowserTimezoneAbbr(): string {
  try {
    const parts = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// ── DD/MM/YYYY maintenance display formatters ──────────────────────────────
//
// The owner explicitly requested DD/MM/YYYY for all human-readable
// maintenance dates, with time and timezone shown clearly (e.g.
// "15/08/2026 • 5:30 PM IST"). These are hand-built rather than delegated
// to toLocaleDateString(navigator.language, ...) so the format is fixed and
// predictable regardless of the visitor's browser locale — a US-locale
// visitor must see the same DD/MM/YYYY shape as everyone else. Storage
// remains UTC timestamptz; these always render in the VIEWER's local
// timezone (matching the rest of this file's existing local-time
// conventions), which is the whole reason the timezone abbreviation is
// shown alongside the time.

/** "15/08/2026" — day/month/year, always two-digit day and month. */
export function formatMaintenanceDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${d.getFullYear()}`;
}

/** "5:30 PM" — explicit 12-hour clock with AM/PM, independent of locale. */
export function formatMaintenanceTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const period = hours < 12 ? "AM" : "PM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${period}`;
}

/**
 * "15/08/2026 • 5:30 PM" or, with `withTimezone`, "15/08/2026 • 5:30 PM IST".
 * Returns "" for a missing/invalid input rather than a partial string.
 */
export function formatMaintenanceDateTime(
  iso: string | null | undefined,
  opts?: { withTimezone?: boolean },
): string {
  const date = formatMaintenanceDate(iso);
  const time = formatMaintenanceTime(iso);
  if (!date || !time) return "";
  if (opts?.withTimezone) {
    const tz = getBrowserTimezoneAbbr();
    return tz ? `${date} • ${time} ${tz}` : `${date} • ${time}`;
  }
  return `${date} • ${time}`;
}

/** "1h 12m" / "45m" / "3h" — a short countdown label from a millisecond
 * duration. Never negative (clamped to 0m). Display-only: the countdown
 * text does NOT determine when maintenance actually ends — the lease/state
 * machine in maintenanceLeaseState.ts does. */
export function formatMaintenanceCountdown(msRemaining: number): string {
  const totalMinutes = Math.max(0, Math.floor(msRemaining / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

// ── Time picker helpers ─────────────────────────────────────────────────────

/**
 * Parse free-form time text entered by the user into a canonical HH:mm string.
 *
 * Accepted formats:
 *   3 PM  →  15:00
 *   3:00 PM  →  15:00
 *   03:00 PM  →  15:00
 *   3:05 pm  →  15:05
 *   15:00  →  15:00
 *   15:30  →  15:30
 *   00:00  →  00:00
 *
 * Returns { ok: false, error } for impossible values (hour>23, minute>59, etc.).
 */
export function parseManualTimeInput(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter a time" };

  // 12-hour with optional minutes: "3 PM", "3:00 PM", "3:05 pm"
  const ampmRe = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;
  const ampmMatch = ampmRe.exec(raw);
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1], 10);
    const minute = ampmMatch[2] !== undefined ? parseInt(ampmMatch[2], 10) : 0;
    const period = ampmMatch[3].toUpperCase() as "AM" | "PM";

    if (hour < 1 || hour > 12) return { ok: false, error: "Use a valid time such as 3:30 PM or 15:30" };
    if (minute < 0 || minute > 59) return { ok: false, error: "Use a valid time such as 3:30 PM or 15:30" };

    if (period === "AM") {
      if (hour === 12) hour = 0;
    } else {
      if (hour !== 12) hour += 12;
    }

    return {
      ok: true,
      value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    };
  }

  // 24-hour: "15:30", "00:00", "9:05"
  const h24Re = /^(\d{1,2}):(\d{2})$/;
  const h24Match = h24Re.exec(raw);
  if (h24Match) {
    const hour = parseInt(h24Match[1], 10);
    const minute = parseInt(h24Match[2], 10);
    if (hour < 0 || hour > 23) return { ok: false, error: "Use a valid time such as 3:30 PM or 15:30" };
    if (minute < 0 || minute > 59) return { ok: false, error: "Use a valid time such as 3:30 PM or 15:30" };
    return {
      ok: true,
      value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    };
  }

  return { ok: false, error: "Use a valid time such as 3:30 PM or 15:30" };
}

/**
 * Format a canonical HH:mm value for display as "h:mm AM/PM".
 * "15:30" → "3:30 PM"
 * "00:00" → "12:00 AM"
 * "12:00" → "12:00 PM"
 */
export function formatCanonicalTimeForDisplay(value: string): string {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return value;
  const [hStr, mStr] = value.split(":");
  const h24 = parseInt(hStr, 10);
  const minute = parseInt(mStr, 10);
  const period = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}

/**
 * Combine clock parts (12-hour, minute, AM/PM) into a canonical HH:mm string.
 */
export function normalizeClockTime(
  hour12: number,
  minute: number,
  period: "AM" | "PM",
): string {
  let h24 = hour12 % 12;
  if (period === "PM") h24 += 12;
  return `${String(h24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Convert a canonical HH:mm string to 12-hour clock parts.
 */
export function canonicalTimeToClockParts(
  value: string,
): { hour12: number; minute: number; period: "AM" | "PM" } {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) {
    return { hour12: 12, minute: 0, period: "AM" };
  }
  const [hStr, mStr] = value.split(":");
  const h24 = parseInt(hStr, 10);
  const minute = parseInt(mStr, 10);
  const period: "AM" | "PM" = h24 < 12 ? "AM" : "PM";
  const hour12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { hour12, minute, period };
}
