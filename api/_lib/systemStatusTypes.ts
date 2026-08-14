/**
 * System Status — canonical type definitions.
 * All timestamps are UTC ISO-8601 strings.
 * This file is server-only; do NOT import into the Vite client bundle.
 */

export type MaintenanceWindowStatus = "scheduled" | "cancelled";

export type MaintenanceWindow = {
  id: string;
  title: string;
  message: string;
  starts_at: string;
  ends_at: string;
  announce_from: string;
  status: MaintenanceWindowStatus;
  created_at: string;
  updated_at: string;
};

export type ManualMaintenance = {
  enabled: boolean;
  incident_id: string;
  title: string;
  message: string;
  started_at: string;
  estimated_end_at: string | null;
};

export type Announcement = {
  id: string;
  title: string;
  message: string;
  published_at: string;
  updated_at: string;
};

export type SystemStatusDocument = {
  schema_version: 1;
  revision: string;
  manual_maintenance: ManualMaintenance | null;
  windows: MaintenanceWindow[];
  /** Independent scrolling banner — visible even when state is operational */
  announcement: Announcement | null;
  updated_at: string;
};

export type PublicSystemStatusState =
  | "operational"
  | "upcoming"
  | "maintenance"
  | "degraded"
  | "outage"
  | "unknown";

export type PublicStatusSource = "manual" | "scheduled" | "automatic_health" | "none";

export type BackendHealthStatus = "healthy" | "degraded" | "unreachable" | "unknown";

export type PublicSystemStatus = {
  schema_version: 1;
  revision: string;
  server_now: string;
  state: PublicSystemStatusState;
  blocking: boolean;
  source: PublicStatusSource;
  title: string | null;
  message: string | null;
  starts_at: string | null;
  ends_at: string | null;
  estimated_end_at: string | null;
  next_window: {
    id: string;
    title: string;
    message: string;
    starts_at: string;
    ends_at: string;
    announce_from: string;
  } | null;
  backend_health: {
    status: BackendHealthStatus;
    checked_at: string;
  };
  public_status_url: string | null;
  /** Independent broadcast announcement (separate from maintenance state) */
  active_announcement: {
    id: string;
    title: string;
    message: string;
    published_at: string;
  } | null;
};

/** Shapes accepted by the Master Admin write endpoint */
export type StartManualMaintenancePayload = {
  action: "start_manual";
  revision: string;
  title: string;
  message: string;
  estimated_end_at: string | null;
};

export type EndManualMaintenancePayload = {
  action: "end_manual";
  revision: string;
};

export type CreateWindowPayload = {
  action: "create_window";
  revision: string;
  title: string;
  message: string;
  starts_at: string;
  ends_at: string;
  announce_from: string;
};

export type CancelWindowPayload = {
  action: "cancel_window";
  revision: string;
  window_id: string;
};

export type PublishAnnouncementPayload = {
  action: "publish_announcement";
  revision: string;
  title: string;
  message: string;
};

export type ClearAnnouncementPayload = {
  action: "clear_announcement";
  revision: string;
};

export type MaintenanceWritePayload =
  | StartManualMaintenancePayload
  | EndManualMaintenancePayload
  | CreateWindowPayload
  | CancelWindowPayload
  | PublishAnnouncementPayload
  | ClearAnnouncementPayload;

/** Default empty operational document */
export function defaultStatusDocument(): SystemStatusDocument {
  return {
    schema_version: 1,
    revision: "init",
    manual_maintenance: null,
    windows: [],
    announcement: null,
    updated_at: new Date().toISOString(),
  };
}
