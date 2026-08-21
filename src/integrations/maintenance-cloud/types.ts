/**
 * Types for the Cloud maintenance control plane.
 *
 * This schema is intentionally separate from — and smaller than — the old
 * Edge Config-backed system-status schema in api/_lib/systemStatusTypes.ts.
 * Do NOT import anything from that file here, and do not import anything
 * from here into it. See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md
 * for the full architecture.
 */

export type MaintenanceEnvironment = "preview" | "production";

/** Row shape of public.maintenance_status, as read by the public/anon client. */
export type MaintenanceStatusRow = {
  environment: MaintenanceEnvironment;
  force_maintenance: boolean;
  title: string | null;
  message: string | null;
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
  updated_by: string | null;
};

/** Fields the admin dashboard is allowed to write. Never environment/updated_at/updated_by. */
export type MaintenanceStatusWritable = {
  force_maintenance?: boolean;
  title?: string | null;
  message?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
};

/** Row shape of public.maintenance_admins, as read by the signed-in owner. */
export type MaintenanceAdminRow = {
  user_id: string;
  is_active: boolean;
  can_manage_preview: boolean;
  can_manage_production: boolean;
  can_view_history: boolean;
  created_at: string;
  updated_at: string;
};

/** public.maintenance_history — one row per maintenance OCCURRENCE. Never
 * publicly readable; see infra/maintenance-cloud/migrations/002_add_maintenance_history.sql.
 * Status is DERIVED from these fields by maintenanceHistoryDerivedStatus.ts,
 * never stored. */
export type MaintenanceHistoryKind = "scheduled" | "forced";

export type MaintenanceHistoryRow = {
  id: string;
  environment: MaintenanceEnvironment;
  kind: MaintenanceHistoryKind;
  title: string | null;
  message: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  actual_started_at: string | null;
  actual_ended_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};
