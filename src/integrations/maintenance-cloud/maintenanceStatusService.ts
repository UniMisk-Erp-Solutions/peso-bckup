/**
 * Cloud maintenance status — read (public) and update (admin) I/O.
 *
 * The read path is called by every visitor's browser and must be strictly
 * bounded and fail-open: see resolveMaintenanceState in
 * src/maintenance/maintenanceResolver.ts, which this module's return type
 * is designed to feed directly (MaintenanceReadOutcome).
 *
 * Never logs the publishable key or any auth token. Never retries — a
 * single bounded attempt per call; the caller (MaintenanceBootstrap /
 * polling loop) decides when to call again.
 */
import { getMaintenanceSupabase, isMaintenanceCloudConfigured } from "./client";
import type { MaintenanceEnvironment, MaintenanceStatusRow, MaintenanceStatusWritable } from "./types";
import { isValidMaintenanceEnvironment, type MaintenanceReadOutcome } from "@/maintenance/maintenanceResolver";

const STATUS_COLUMNS =
  "environment,force_maintenance,title,message,starts_at,ends_at,updated_at,updated_by";

function isMaintenanceStatusRow(v: unknown): v is MaintenanceStatusRow {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    (r.environment === "preview" || r.environment === "production") &&
    typeof r.force_maintenance === "boolean" &&
    typeof r.updated_at === "string"
  );
}

/**
 * Fetch the single maintenance_status row for the given environment.
 * Bounded by `timeoutMs`. Never throws — every failure path returns a
 * structured MaintenanceReadOutcome for the pure resolver to interpret.
 */
export async function fetchMaintenanceStatus(
  environment: string | undefined,
  timeoutMs: number,
): Promise<MaintenanceReadOutcome> {
  if (!isValidMaintenanceEnvironment(environment)) {
    return { kind: "invalid_environment" };
  }

  if (!isMaintenanceCloudConfigured()) {
    return { kind: "not_configured" };
  }

  const client = getMaintenanceSupabase();
  if (!client) {
    return { kind: "not_configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { data, error, status } = await client
      .from("maintenance_status")
      .select(STATUS_COLUMNS)
      .eq("environment", environment)
      .abortSignal(controller.signal);

    if (error) {
      if (controller.signal.aborted) return { kind: "timeout" };
      return { kind: "http_error", status };
    }

    if (!Array.isArray(data)) return { kind: "malformed" };
    if (data.length === 0) return { kind: "no_rows" };
    if (data.length > 1) return { kind: "multiple_rows" };

    const row = data[0];
    if (!isMaintenanceStatusRow(row)) return { kind: "malformed" };

    return { kind: "success", row };
  } catch (err) {
    if (controller.signal.aborted) return { kind: "timeout" };
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("load failed")) {
      return { kind: "network_error" };
    }
    return { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

export type MaintenanceUpdateResult =
  | { ok: true; row: MaintenanceStatusRow }
  | { ok: false; error: string };

/**
 * Admin-only write. Relies entirely on Cloud RLS (§8/§9 of the architecture
 * doc) to enforce environment authority and active-admin status — this
 * function does not itself decide whether the caller is authorized. Only
 * ever sends the writable subset of columns; environment/updated_at/
 * updated_by are never included in the payload (they are also blocked at
 * the database grant level, see infra/maintenance-cloud/migrations).
 */
export async function updateMaintenanceStatus(
  environment: MaintenanceEnvironment,
  patch: MaintenanceStatusWritable,
): Promise<MaintenanceUpdateResult> {
  const client = getMaintenanceSupabase();
  if (!client) {
    return { ok: false, error: "Maintenance Cloud client is not configured." };
  }

  const { data, error } = await client
    .from("maintenance_status")
    .update(patch)
    .eq("environment", environment)
    .select(STATUS_COLUMNS)
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }
  if (!isMaintenanceStatusRow(data)) {
    return { ok: false, error: "Unexpected response shape after update." };
  }
  return { ok: true, row: data };
}

/** Read-back helper used by the admin dashboard to confirm a write actually
 * persisted, rather than trusting the optimistic form state. */
export async function readMaintenanceStatusForAdmin(
  environment: MaintenanceEnvironment,
): Promise<MaintenanceUpdateResult> {
  const client = getMaintenanceSupabase();
  if (!client) {
    return { ok: false, error: "Maintenance Cloud client is not configured." };
  }
  const { data, error } = await client
    .from("maintenance_status")
    .select(STATUS_COLUMNS)
    .eq("environment", environment)
    .single();
  if (error) {
    return { ok: false, error: error.message };
  }
  if (!isMaintenanceStatusRow(data)) {
    return { ok: false, error: "Unexpected response shape." };
  }
  return { ok: true, row: data };
}
