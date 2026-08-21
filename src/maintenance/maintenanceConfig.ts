/**
 * Client-side configuration for the Cloud maintenance control plane.
 *
 * Default DISABLED — an absent or non-"true" VITE_MAINTENANCE_CONTROL_ENABLED
 * means zero Cloud requests and immediate normal-app rendering. Mirrors the
 * existing VITE_SYSTEM_STATUS_CONTROL_ENABLED convention in
 * src/config/systemStatusFeature.ts. Do NOT fall back to true.
 *
 * Polling no longer determines maintenance PRECISION — exact starts_at/
 * ends_at transitions are driven by local timers (see
 * src/maintenance/maintenanceLeaseState.ts's scheduleAt). Background polling
 * exists only to pick up changes an admin makes elsewhere (a cancellation, a
 * new schedule, disabling forced maintenance) and to refresh the trusted
 * lease before it would otherwise expire. Both intervals default to 120s —
 * see docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §35 for why the
 * previous 60s/20s split was reduced and unified.
 */

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_POLL_INTERVAL_NORMAL_MS = 120_000;
const DEFAULT_POLL_INTERVAL_ACTIVE_MS = 120_000;
const DEFAULT_ACTIVE_FAILURE_GRACE_MS = 180_000;

export const MAINTENANCE_CONTROL_ENABLED =
  import.meta.env.VITE_MAINTENANCE_CONTROL_ENABLED === "true";

export const MAINTENANCE_ENV = import.meta.env.VITE_MAINTENANCE_ENV as string | undefined;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MAINTENANCE_REQUEST_TIMEOUT_MS = parsePositiveInt(
  import.meta.env.VITE_MAINTENANCE_REQUEST_TIMEOUT_MS as string | undefined,
  DEFAULT_TIMEOUT_MS,
);

/** Poll interval while the app is in its normal (non-blocking) state. */
export const MAINTENANCE_POLL_INTERVAL_NORMAL_MS = parsePositiveInt(
  import.meta.env.VITE_MAINTENANCE_POLL_INTERVAL_NORMAL_MS as string | undefined,
  DEFAULT_POLL_INTERVAL_NORMAL_MS,
);

/** Poll interval while the maintenance screen is actively showing, so a
 * disabled toggle restores the app without a manual reload (§19 of the
 * architecture doc). Not a substitute for exact transition precision — see
 * module doc comment above. */
export const MAINTENANCE_POLL_INTERVAL_ACTIVE_MS = parsePositiveInt(
  import.meta.env.VITE_MAINTENANCE_POLL_INTERVAL_ACTIVE_MS as string | undefined,
  DEFAULT_POLL_INTERVAL_ACTIVE_MS,
);

/** How long a forced-maintenance lease is trusted through after its last
 * successful Cloud confirmation before failing open. Forced maintenance has
 * no natural end time, so without this bound a Cloud outage would keep the
 * app blocked indefinitely instead of eventually failing open. */
export const MAINTENANCE_ACTIVE_FAILURE_GRACE_MS = parsePositiveInt(
  import.meta.env.VITE_MAINTENANCE_ACTIVE_FAILURE_GRACE_MS as string | undefined,
  DEFAULT_ACTIVE_FAILURE_GRACE_MS,
);
