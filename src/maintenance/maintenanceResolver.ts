/**
 * Pure maintenance state resolver — no I/O, no React, no Supabase import.
 *
 * Takes the OUTCOME of a Cloud read attempt (already performed elsewhere,
 * see src/integrations/maintenance-cloud/maintenanceStatusService.ts) and
 * the current time, and returns exactly one of: normal / upcoming /
 * maintenance. See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §11
 * for the full state-machine contract this implements.
 *
 * FAIL-OPEN CONTRACT: every non-"success" outcome kind resolves to
 * `{ state: "normal" }`. This is the single choke point that enforces
 * Decision C (fail open) — do not special-case any failure kind here to
 * produce anything other than "normal".
 */

import type { MaintenanceEnvironment, MaintenanceStatusRow } from "@/integrations/maintenance-cloud/types";

/** Every way a Cloud read attempt can conclude. Exactly one of these per read. */
export type MaintenanceReadOutcome =
  | { kind: "success"; row: MaintenanceStatusRow }
  | { kind: "not_configured" }
  | { kind: "invalid_environment" }
  | { kind: "timeout" }
  | { kind: "network_error" }
  | { kind: "http_error"; status?: number }
  | { kind: "malformed" }
  | { kind: "no_rows" }
  | { kind: "multiple_rows" };

export type MaintenanceSource = "forced" | "scheduled";

export type MaintenanceResolution =
  | { state: "maintenance"; source: MaintenanceSource; row: MaintenanceStatusRow }
  | { state: "upcoming"; row: MaintenanceStatusRow }
  | { state: "normal"; row: MaintenanceStatusRow | null; outcome: MaintenanceReadOutcome["kind"] };

/** True when both timestamps are present and well-formed. A half-configured
 * window (one set, one null) is invalid per the DB constraint (§8 of the
 * migration) and must never be trusted here either, defense in depth. */
function hasValidWindow(row: MaintenanceStatusRow): row is MaintenanceStatusRow & {
  starts_at: string;
  ends_at: string;
} {
  if (!row.starts_at || !row.ends_at) return false;
  const start = new Date(row.starts_at).getTime();
  const end = new Date(row.ends_at).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

export function resolveMaintenanceState(
  outcome: MaintenanceReadOutcome,
  now: Date,
): MaintenanceResolution {
  if (outcome.kind !== "success") {
    // FAIL OPEN — every failure kind, including ones added in the future,
    // resolves to "normal". No cached/remembered state is consulted here;
    // the caller (MaintenanceBootstrap) is responsible for never treating
    // a stale in-memory value as equivalent to a fresh "success" outcome.
    return { state: "normal", row: null, outcome: outcome.kind };
  }

  const row = outcome.row;

  if (row.force_maintenance) {
    return { state: "maintenance", source: "forced", row };
  }

  if (hasValidWindow(row)) {
    const nowMs = now.getTime();
    const startMs = new Date(row.starts_at).getTime();
    const endMs = new Date(row.ends_at).getTime();

    if (nowMs >= startMs && nowMs < endMs) {
      return { state: "maintenance", source: "scheduled", row };
    }
    if (nowMs < startMs) {
      return { state: "upcoming", row };
    }
    // nowMs >= endMs -> expired schedule, falls through to normal below.
  }

  return { state: "normal", row, outcome: "success" };
}

/** Validates VITE_MAINTENANCE_ENV before any network call is attempted. */
export function isValidMaintenanceEnvironment(
  value: string | undefined,
): value is MaintenanceEnvironment {
  return value === "preview" || value === "production";
}
