/**
 * Cloud maintenance HISTORY — read-only I/O. Owner/admin information only;
 * never publicly readable. Database RLS is authoritative (see
 * infra/maintenance-cloud/migrations/002_add_maintenance_history.sql) — this
 * module does not itself decide whether the caller is authorized to see
 * anything, it just issues the (RLS-filtered) query and reports the result.
 *
 * There is deliberately no write function here: history is entirely
 * server-derived via a trigger on maintenance_status (see
 * maintenanceStatusService.ts's updateMaintenanceStatus) — no application
 * code ever inserts/updates a maintenance_history row directly, matching
 * the database's own grants (no INSERT/UPDATE/DELETE grant exists for any
 * application role).
 */
import { getMaintenanceSupabase } from "./client";
import type {
  MaintenanceEnvironment,
  MaintenanceHistoryKind,
  MaintenanceHistoryRow,
} from "./types";
import type { MaintenanceHistoryDerivedStatus } from "@/maintenance/maintenanceHistoryDerivedStatus";

const HISTORY_COLUMNS =
  "id,environment,kind,title,message,scheduled_start_at,scheduled_end_at," +
  "actual_started_at,actual_ended_at,cancelled_at,created_at,created_by,updated_at,updated_by";

export const MAINTENANCE_HISTORY_PAGE_SIZE = 20;

export type MaintenanceHistoryFilters = {
  environment: MaintenanceEnvironment;
  page: number; // 1-based
  pageSize?: number;
  kind?: MaintenanceHistoryKind;
  /** Client-derived status filter — applied after the derived-status
   * computation, since status is never stored. See §24 of the architecture
   * doc: date-range and status filtering stay simple for V1 and are not
   * expected to scale past a small operational table. */
  status?: MaintenanceHistoryDerivedStatus;
  dateFrom?: string; // ISO
  dateTo?: string; // ISO
};

export type MaintenanceHistoryPage =
  | { ok: true; rows: MaintenanceHistoryRow[]; totalCount: number; page: number; pageSize: number }
  | { ok: false; error: string };

/**
 * Paginated Cloud read of maintenance history for one environment. Never
 * fetches unlimited history — bounded by pageSize (default 20).
 */
export async function readMaintenanceHistory(
  filters: MaintenanceHistoryFilters,
): Promise<MaintenanceHistoryPage> {
  const client = getMaintenanceSupabase();
  if (!client) {
    return { ok: false, error: "Maintenance Cloud client is not configured." };
  }

  const pageSize = filters.pageSize ?? MAINTENANCE_HISTORY_PAGE_SIZE;
  const page = Math.max(1, filters.page);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = client
    .from("maintenance_history")
    .select(HISTORY_COLUMNS, { count: "exact" })
    .eq("environment", filters.environment)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filters.kind) {
    query = query.eq("kind", filters.kind);
  }
  if (filters.dateFrom) {
    query = query.gte("created_at", filters.dateFrom);
  }
  if (filters.dateTo) {
    query = query.lte("created_at", filters.dateTo);
  }

  const { data, error, count } = await query;

  if (error) {
    return { ok: false, error: error.message };
  }
  if (!Array.isArray(data)) {
    return { ok: false, error: "Unexpected response shape." };
  }

  return {
    ok: true,
    rows: data as MaintenanceHistoryRow[],
    totalCount: count ?? data.length,
    page,
    pageSize,
  };
}
