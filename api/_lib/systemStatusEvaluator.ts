/**
 * Pure functions for evaluating SystemStatusDocument → PublicSystemStatus.
 * No I/O, no side effects — safe to unit-test without network.
 * Server-only. Do NOT import into the Vite client bundle.
 */

import type {
  SystemStatusDocument,
  MaintenanceWindow,
  ManualMaintenance,
  PublicSystemStatus,
  PublicSystemStatusState,
  PublicStatusSource,
  BackendHealthStatus,
} from "./systemStatusTypes.js";

/** How many old cancelled/expired windows to retain in the document */
export const MAX_EXPIRED_WINDOWS = 20;

export type EvaluationContext = {
  serverNow: Date;
  backendHealth: { status: BackendHealthStatus; checked_at: string };
  publicStatusUrl: string | null;
};

/** Returns the active scheduled window at the given server time, or null */
export function getActiveScheduledWindow(
  windows: MaintenanceWindow[],
  now: Date,
): MaintenanceWindow | null {
  for (const w of windows) {
    if (w.status !== "scheduled") continue;
    const start = new Date(w.starts_at);
    const end = new Date(w.ends_at);
    if (now >= start && now < end) return w;
  }
  return null;
}

/** Returns the next upcoming window that hasn't started yet, or null */
export function getNextUpcomingWindow(
  windows: MaintenanceWindow[],
  now: Date,
): MaintenanceWindow | null {
  const upcoming = windows
    .filter((w) => w.status === "scheduled" && new Date(w.starts_at) > now)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  return upcoming[0] ?? null;
}

/** Returns true when an upcoming window is in its announcement period */
export function isInAnnouncementPeriod(window: MaintenanceWindow, now: Date): boolean {
  const announceFrom = new Date(window.announce_from);
  const start = new Date(window.starts_at);
  return now >= announceFrom && now < start;
}

/** Evaluate the document to a normalized public status */
export function evaluateSystemStatus(
  doc: SystemStatusDocument,
  ctx: EvaluationContext,
): PublicSystemStatus {
  const { serverNow, backendHealth, publicStatusUrl } = ctx;
  const now = serverNow;
  const revision = doc.revision;

  // Announcement is independent of state — always included when present
  const ann = doc.announcement ?? null;
  const active_announcement = ann
    ? { id: ann.id, title: ann.title, message: ann.message, published_at: ann.published_at }
    : null;

  // 1. Manual maintenance takes highest precedence
  const manual: ManualMaintenance | null = doc.manual_maintenance;
  if (manual?.enabled) {
    return {
      schema_version: 1,
      revision,
      server_now: now.toISOString(),
      state: "maintenance",
      blocking: true,
      source: "manual",
      title: manual.title,
      message: manual.message,
      starts_at: manual.started_at,
      ends_at: null,
      estimated_end_at: manual.estimated_end_at,
      next_window: null,
      backend_health: backendHealth,
      public_status_url: publicStatusUrl,
      active_announcement,
    };
  }

  // 2. Active scheduled window
  const activeWindow = getActiveScheduledWindow(doc.windows, now);
  if (activeWindow) {
    return {
      schema_version: 1,
      revision,
      server_now: now.toISOString(),
      state: "maintenance",
      blocking: true,
      source: "scheduled",
      title: activeWindow.title,
      message: activeWindow.message,
      starts_at: activeWindow.starts_at,
      ends_at: activeWindow.ends_at,
      estimated_end_at: activeWindow.ends_at,
      next_window: null,
      backend_health: backendHealth,
      public_status_url: publicStatusUrl,
      active_announcement,
    };
  }

  // 3. Upcoming announcement period for the next scheduled window
  const nextWindow = getNextUpcomingWindow(doc.windows, now);
  if (nextWindow && isInAnnouncementPeriod(nextWindow, now)) {
    return {
      schema_version: 1,
      revision,
      server_now: now.toISOString(),
      state: "upcoming",
      blocking: false,
      source: "scheduled",
      title: nextWindow.title,
      message: nextWindow.message,
      starts_at: nextWindow.starts_at,
      ends_at: nextWindow.ends_at,
      estimated_end_at: nextWindow.ends_at,
      next_window: buildNextWindowSummary(nextWindow),
      backend_health: backendHealth,
      public_status_url: publicStatusUrl,
      active_announcement,
    };
  }

  // 4. Operational
  return {
    schema_version: 1,
    revision,
    server_now: now.toISOString(),
    state: "operational",
    blocking: false,
    source: "none",
    title: null,
    message: null,
    starts_at: null,
    ends_at: null,
    estimated_end_at: null,
    next_window: nextWindow ? buildNextWindowSummary(nextWindow) : null,
    backend_health: backendHealth,
    public_status_url: publicStatusUrl,
    active_announcement,
  };
}

function buildNextWindowSummary(
  w: MaintenanceWindow | null,
): PublicSystemStatus["next_window"] {
  if (!w) return null;
  return {
    id: w.id,
    title: w.title,
    message: w.message,
    starts_at: w.starts_at,
    ends_at: w.ends_at,
    announce_from: w.announce_from,
  };
}

/** Prune expired/cancelled windows, keeping only MAX_EXPIRED_WINDOWS */
export function pruneOldWindows(
  windows: MaintenanceWindow[],
  now: Date,
): MaintenanceWindow[] {
  const active = windows.filter(
    (w) => w.status === "scheduled" && new Date(w.ends_at) > now,
  );
  const expired = windows
    .filter((w) => w.status === "cancelled" || new Date(w.ends_at) <= now)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, MAX_EXPIRED_WINDOWS);
  return [...active, ...expired];
}

/** Validation helpers */
export function validateWindow(
  w: { title: string; message: string; starts_at: string; ends_at: string; announce_from: string },
  existingWindows: MaintenanceWindow[],
  windowId?: string,
): string | null {
  if (!w.title.trim()) return "Title is required";
  if (w.title.length > 200) return "Title must be 200 characters or fewer";
  if (!w.message.trim()) return "Message is required";
  if (w.message.length > 2000) return "Message must be 2000 characters or fewer";

  const start = new Date(w.starts_at);
  const end = new Date(w.ends_at);
  const announceFrom = new Date(w.announce_from);

  if (isNaN(start.getTime())) return "Invalid start time";
  if (isNaN(end.getTime())) return "Invalid end time";
  if (isNaN(announceFrom.getTime())) return "Invalid announcement time";
  if (end <= start) return "End time must be after start time";
  if (announceFrom > start) return "Announcement time must be at or before start time";

  // Overlap check (skip against self when editing)
  const others = existingWindows.filter(
    (ew) => ew.status === "scheduled" && ew.id !== windowId,
  );
  for (const other of others) {
    const oStart = new Date(other.starts_at);
    const oEnd = new Date(other.ends_at);
    if (start < oEnd && end > oStart) {
      return `Overlaps with existing window: "${other.title}"`;
    }
  }

  return null;
}

export function validateManualMaintenance(payload: {
  title: string;
  message: string;
  estimated_end_at: string | null;
}): string | null {
  if (!payload.title.trim()) return "Title is required";
  if (payload.title.length > 200) return "Title must be 200 characters or fewer";
  if (!payload.message.trim()) return "Message is required";
  if (payload.message.length > 2000) return "Message must be 2000 characters or fewer";
  if (payload.estimated_end_at !== null) {
    const d = new Date(payload.estimated_end_at);
    if (isNaN(d.getTime())) return "Invalid estimated end time";
  }
  return null;
}

export function makeRevision(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
