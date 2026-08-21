/**
 * Pure schedule validation for the Cloud maintenance admin dashboard.
 *
 * Mirrors the DB constraint in
 * infra/maintenance-cloud/migrations/001_create_maintenance_control_plane.sql
 * (maintenance_status_window_check): both starts_at/ends_at null, or both
 * present with ends_at strictly after starts_at. No I/O, no React.
 */

export type ScheduleValidationResult = { ok: true } | { ok: false; error: string };

/** `startsAt`/`endsAt` are ISO-8601 strings, or null/empty for "no schedule". */
export function validateMaintenanceSchedule(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
): ScheduleValidationResult {
  const hasStart = Boolean(startsAt);
  const hasEnd = Boolean(endsAt);

  if (!hasStart && !hasEnd) {
    return { ok: true };
  }
  if (hasStart && !hasEnd) {
    return { ok: false, error: "End date/time is required when a start is set." };
  }
  if (!hasStart && hasEnd) {
    return { ok: false, error: "Start date/time is required when an end is set." };
  }

  const startMs = new Date(startsAt as string).getTime();
  const endMs = new Date(endsAt as string).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, error: "Start and end must be valid dates." };
  }
  if (endMs <= startMs) {
    return { ok: false, error: "End must be after start." };
  }
  return { ok: true };
}
