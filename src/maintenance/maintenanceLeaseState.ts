/**
 * Trusted maintenance lease — the stateful layer on top of the pure,
 * single-shot resolveMaintenanceState().
 *
 * THE BUG THIS FIXES: the original MaintenanceBootstrap called
 * resolveMaintenanceState(outcome, now) on EVERY poll and unconditionally
 * replaced the rendered resolution with its result. Since every non-success
 * outcome resolves to "normal", a single transient read failure (timeout /
 * network error / a momentarily-paused Cloud project) during an ACTIVE
 * maintenance window instantly unmounted CloudMaintenanceScreen and mounted
 * the local app — even though nothing about the actual maintenance schedule
 * had changed. This was reported live: a ~90-minute scheduled window
 * unlocked after about a minute. See
 * docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §35 for the full
 * incident writeup.
 *
 * THE FIX: once a FRESH, VALID Cloud success establishes a maintenance
 * window (scheduled or forced), that window is held in memory as a
 * "lease" that survives subsequent transient failures. A lease is only
 * ever replaced or cleared by another FRESH SUCCESS, or by its own natural
 * expiry (scheduled: ends_at; forced: a bounded failure grace period).
 *
 * THIS DOES NOT WEAKEN THE ORIGINAL FAIL-OPEN GUARANTEE FOR A FRESH BROWSER
 * TAB: with no lease yet acquired (a brand-new page load, or after a lease
 * has expired), a failure still resolves to "normal" — see
 * deriveMaintenanceResolution's fallthrough. The lease only ever narrows
 * the window during which a failure is trusted-through, and that window is
 * always bounded (ends_at for scheduled, a fixed grace period for forced).
 */
import type { MaintenanceEnvironment, MaintenanceStatusRow } from "@/integrations/maintenance-cloud/types";
import type { MaintenanceReadOutcome, MaintenanceResolution } from "./maintenanceResolver";

export type ScheduledLease = {
  environment: MaintenanceEnvironment;
  starts_at: string; // ISO
  ends_at: string; // ISO
  title: string | null;
  message: string | null;
  updated_at: string;
};

export type ForcedLease = {
  environment: MaintenanceEnvironment;
  title: string | null;
  message: string | null;
  updated_at: string;
  /** When a fresh Cloud success last confirmed force_maintenance=true.
   * A stale lease (no confirmation within the grace window) expires. */
  lastConfirmedAt: string; // ISO
};

export type MaintenanceLeaseState = {
  scheduledLease: ScheduledLease | null;
  forcedLease: ForcedLease | null;
};

export function createEmptyLeaseState(): MaintenanceLeaseState {
  return { scheduledLease: null, forcedLease: null };
}

function hasValidWindow(row: MaintenanceStatusRow): row is MaintenanceStatusRow & {
  starts_at: string;
  ends_at: string;
} {
  if (!row.starts_at || !row.ends_at) return false;
  const start = new Date(row.starts_at).getTime();
  const end = new Date(row.ends_at).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

/** Derives the next lease state from a FRESH success outcome. Replaces both
 * leases wholesale — a fresh success is always authoritative. */
function leaseFromFreshSuccess(row: MaintenanceStatusRow, now: Date): MaintenanceLeaseState {
  const forcedLease: ForcedLease | null = row.force_maintenance
    ? {
        environment: row.environment,
        title: row.title,
        message: row.message,
        updated_at: row.updated_at,
        lastConfirmedAt: now.toISOString(),
      }
    : null;

  let scheduledLease: ScheduledLease | null = null;
  if (hasValidWindow(row)) {
    const endMs = new Date(row.ends_at).getTime();
    // A fresh success carrying an already-expired window establishes no
    // lease — an expired schedule is equivalent to no schedule.
    if (now.getTime() < endMs) {
      scheduledLease = {
        environment: row.environment,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        title: row.title,
        message: row.message,
        updated_at: row.updated_at,
      };
    }
  }

  return { scheduledLease, forcedLease };
}

function expireScheduledLeaseIfPast(lease: ScheduledLease | null, now: Date): ScheduledLease | null {
  if (!lease) return null;
  const endMs = new Date(lease.ends_at).getTime();
  return now.getTime() < endMs ? lease : null;
}

function expireForcedLeaseIfStale(
  lease: ForcedLease | null,
  now: Date,
  graceMs: number,
): ForcedLease | null {
  if (!lease) return null;
  const lastConfirmedMs = new Date(lease.lastConfirmedAt).getTime();
  return now.getTime() - lastConfirmedMs < graceMs ? lease : null;
}

/**
 * The single state-transition function driving the whole lease system.
 * Call once per poll result (fresh success or transient failure) plus once
 * per exact-transition timer tick (with a synthetic "no outcome" tick via
 * `tickExpiry`, see below) to keep leases correctly bounded even absent any
 * network activity.
 */
export function applyMaintenanceOutcome(
  prev: MaintenanceLeaseState,
  outcome: MaintenanceReadOutcome,
  now: Date,
  forcedGraceMs: number,
): MaintenanceLeaseState {
  if (outcome.kind === "success") {
    return leaseFromFreshSuccess(outcome.row, now);
  }
  // Transient failure: preserve existing leases, subject to their own
  // independent, bounded expiry — never extended by the failure itself.
  return {
    scheduledLease: expireScheduledLeaseIfPast(prev.scheduledLease, now),
    forcedLease: expireForcedLeaseIfStale(prev.forcedLease, now, forcedGraceMs),
  };
}

/** Re-evaluates expiry with no new Cloud read — used by the exact-transition
 * local timers so a schedule's ends_at (or a forced lease's grace period)
 * is enforced on the wall clock, not merely on the next poll. */
export function tickLeaseExpiry(
  prev: MaintenanceLeaseState,
  now: Date,
  forcedGraceMs: number,
): MaintenanceLeaseState {
  return {
    scheduledLease: expireScheduledLeaseIfPast(prev.scheduledLease, now),
    forcedLease: expireForcedLeaseIfStale(prev.forcedLease, now, forcedGraceMs),
  };
}

function rowFromScheduledLease(lease: ScheduledLease): MaintenanceStatusRow {
  return {
    environment: lease.environment,
    force_maintenance: false,
    title: lease.title,
    message: lease.message,
    starts_at: lease.starts_at,
    ends_at: lease.ends_at,
    updated_at: lease.updated_at,
    updated_by: null,
  };
}

function rowFromForcedLease(lease: ForcedLease): MaintenanceStatusRow {
  return {
    environment: lease.environment,
    force_maintenance: true,
    title: lease.title,
    message: lease.message,
    starts_at: null,
    ends_at: null,
    updated_at: lease.updated_at,
    updated_by: null,
  };
}

/**
 * Derives the UI-facing resolution from the current lease state. Forced
 * takes precedence over scheduled — "fresh Cloud success says force=true:
 * forced maintenance takes precedence".
 */
export function deriveMaintenanceResolution(
  lease: MaintenanceLeaseState,
  now: Date,
  lastOutcomeKind: MaintenanceReadOutcome["kind"] = "not_configured",
): MaintenanceResolution {
  if (lease.forcedLease) {
    return { state: "maintenance", source: "forced", row: rowFromForcedLease(lease.forcedLease) };
  }

  if (lease.scheduledLease) {
    const nowMs = now.getTime();
    const startMs = new Date(lease.scheduledLease.starts_at).getTime();
    const endMs = new Date(lease.scheduledLease.ends_at).getTime();

    if (nowMs >= startMs && nowMs < endMs) {
      return { state: "maintenance", source: "scheduled", row: rowFromScheduledLease(lease.scheduledLease) };
    }
    if (nowMs < startMs) {
      return { state: "upcoming", row: rowFromScheduledLease(lease.scheduledLease) };
    }
    // nowMs >= endMs: expired. tickLeaseExpiry/applyMaintenanceOutcome should
    // already have cleared this lease, but fall through defensively.
  }

  return { state: "normal", row: null, outcome: lastOutcomeKind };
}

/**
 * The earliest FUTURE timestamp (epoch ms, strictly after `now`) at which
 * the derived resolution could change on its own, with no new Cloud read —
 * i.e. the next moment a local exact-transition timer should fire. Returns
 * null when no lease is held, or when every candidate boundary has already
 * passed (defensive — tickLeaseExpiry/applyMaintenanceOutcome should have
 * already cleared such a lease).
 *
 * Only ever returns a boundary that is still ahead of `now`: a schedule's
 * own starts_at is irrelevant once it is already active (only ends_at
 * matters from then on), and including an already-past timestamp here would
 * make scheduleAt fire immediately (delay clamped to 0), which would busy-
 * loop the transition timer.
 */
export function nextLeaseTransitionMs(
  lease: MaintenanceLeaseState,
  now: Date,
  forcedGraceMs: number,
): number | null {
  const nowMs = now.getTime();
  const candidates: number[] = [];

  if (lease.scheduledLease) {
    const startMs = new Date(lease.scheduledLease.starts_at).getTime();
    const endMs = new Date(lease.scheduledLease.ends_at).getTime();
    if (startMs > nowMs) candidates.push(startMs);
    if (endMs > nowMs) candidates.push(endMs);
  }
  if (lease.forcedLease) {
    const expiryMs = new Date(lease.forcedLease.lastConfirmedAt).getTime() + forcedGraceMs;
    if (expiryMs > nowMs) candidates.push(expiryMs);
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** Safe setTimeout: clamps to the platform's max signed 32-bit delay and
 * refuses negative delays (fires "now" via a 0ms timeout instead). Returns
 * a cancel function. A delay beyond the max re-arms itself until the real
 * target time is reached, so a schedule far in the future is still handled
 * correctly rather than firing immediately (the historical Node/browser
 * setTimeout overflow footgun). */
const MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1

export function scheduleAt(targetMs: number, nowMs: number, callback: () => void): () => void {
  let cancelled = false;
  let handle: ReturnType<typeof setTimeout> | null = null;

  function arm(fromMs: number) {
    const remaining = Math.max(0, targetMs - fromMs);
    if (remaining > MAX_TIMEOUT_MS) {
      handle = setTimeout(() => {
        if (!cancelled) arm(fromMs + MAX_TIMEOUT_MS);
      }, MAX_TIMEOUT_MS);
      return;
    }
    handle = setTimeout(() => {
      if (!cancelled) callback();
    }, remaining);
  }

  arm(nowMs);

  return () => {
    cancelled = true;
    if (handle) clearTimeout(handle);
  };
}
