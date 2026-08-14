/**
 * Client-side pure helpers for system availability.
 * These types mirror PublicSystemStatus from the API but are safe to ship in the client bundle.
 */

export type SystemState =
  | "operational"
  | "upcoming"
  | "maintenance"
  | "degraded"
  | "outage"
  | "unknown";

export type PublicStatusSource = "manual" | "scheduled" | "automatic_health" | "none";

export type BackendHealthStatus = "healthy" | "degraded" | "unreachable" | "unknown";

export type NextWindowSummary = {
  id: string;
  title: string;
  message: string;
  starts_at: string;
  ends_at: string;
  announce_from: string;
};

/** Shape of /api/system-status response */
export type SystemStatusPayload = {
  schema_version: 1;
  revision: string;
  server_now: string;
  state: SystemState;
  blocking: boolean;
  source: PublicStatusSource;
  title: string | null;
  message: string | null;
  starts_at: string | null;
  ends_at: string | null;
  estimated_end_at: string | null;
  next_window: NextWindowSummary | null;
  backend_health: {
    status: BackendHealthStatus;
    checked_at: string;
  };
  public_status_url: string | null;
  /** Independent broadcast announcement (optional for backward compat with older API responses) */
  active_announcement?: {
    id: string;
    title: string;
    message: string;
    published_at: string;
  } | null;
};

/**
 * True when the state should block non-Master-Admin users.
 * "outage" is kept for backward compatibility with cached API responses;
 * the server no longer generates it automatically.
 */
export function isBlockingState(state: SystemState): boolean {
  return state === "maintenance" || state === "outage";
}

/** Map state to a human-readable severity label */
export function stateToSeverity(
  state: SystemState,
): "ok" | "info" | "warning" | "critical" {
  switch (state) {
    case "operational":
      return "ok";
    case "upcoming":
      return "info";
    case "degraded":
      return "warning";
    case "maintenance":
    case "outage":
      return "critical";
    default:
      return "info";
  }
}

/**
 * Return a banner theme for the system state.
 * Only "upcoming" generates a banner — degraded is no longer shown
 * because the server no longer generates that state automatically.
 */
export function stateToBannerTheme(
  state: SystemState,
): "info" | "warning" | "destructive" | null {
  switch (state) {
    case "upcoming":
      return "info";
    case "maintenance":
    case "outage":
      return "destructive";
    default:
      return null;
  }
}

/** Format a countdown string (e.g. "in 2 h 15 m") */
export function formatCountdown(targetIso: string, nowIso: string): string {
  const diff = new Date(targetIso).getTime() - new Date(nowIso).getTime();
  if (diff <= 0) return "now";
  const totalMin = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `in ${hours} h ${mins} m`;
  return `in ${mins} m`;
}
