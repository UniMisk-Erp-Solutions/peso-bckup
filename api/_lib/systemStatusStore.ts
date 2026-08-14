/**
 * Vendor-agnostic store interface for SystemStatusDocument.
 * Server-only. Do NOT import into the Vite client bundle.
 */

import type { SystemStatusDocument } from "./systemStatusTypes.js";
import { defaultStatusDocument } from "./systemStatusTypes.js";
import { makeRevision, pruneOldWindows } from "./systemStatusEvaluator.js";
import type { MaintenanceWritePayload } from "./systemStatusTypes.js";

export type StoreReadResult =
  | { ok: true; doc: SystemStatusDocument }
  | { ok: false; error: string };

export type StoreWriteResult =
  | { ok: true; doc: SystemStatusDocument }
  | { ok: false; error: string; conflict?: boolean };

export interface SystemStatusStore {
  /**
   * Read the current document. Should never throw — errors returned via result type.
   */
  read(): Promise<StoreReadResult>;

  /**
   * Apply a write payload to the document atomically.
   * Implementations must enforce optimistic-concurrency via payload.revision.
   */
  write(payload: MaintenanceWritePayload, serverNow: Date): Promise<StoreWriteResult>;
}

/**
 * Pure function: apply a write payload to an existing document.
 * Returns the updated document or an error string.
 * No I/O — safe to unit-test.
 */
export function applyWrite(
  current: SystemStatusDocument,
  payload: MaintenanceWritePayload,
  serverNow: Date,
): { doc: SystemStatusDocument } | { error: string; conflict?: boolean } {
  if (current.revision !== payload.revision) {
    return {
      error: `Stale revision: expected "${current.revision}", got "${payload.revision}"`,
      conflict: true,
    };
  }

  const now = serverNow.toISOString();
  const rev = makeRevision();

  switch (payload.action) {
    case "start_manual": {
      if (current.manual_maintenance?.enabled) {
        return { error: "Manual maintenance is already active. End it before starting a new one." };
      }
      const doc: SystemStatusDocument = {
        ...current,
        revision: rev,
        manual_maintenance: {
          enabled: true,
          incident_id: rev,
          title: payload.title,
          message: payload.message,
          started_at: now,
          estimated_end_at: payload.estimated_end_at,
        },
        updated_at: now,
      };
      return { doc };
    }

    case "end_manual": {
      if (!current.manual_maintenance?.enabled) {
        return { error: "No active manual maintenance to end." };
      }
      const doc: SystemStatusDocument = {
        ...current,
        revision: rev,
        manual_maintenance: null,
        updated_at: now,
      };
      return { doc };
    }

    case "create_window": {
      const newWindow = {
        id: rev,
        title: payload.title,
        message: payload.message,
        starts_at: payload.starts_at,
        ends_at: payload.ends_at,
        announce_from: payload.announce_from,
        status: "scheduled" as const,
        created_at: now,
        updated_at: now,
      };
      const doc: SystemStatusDocument = {
        ...current,
        revision: rev,
        windows: pruneOldWindows([...current.windows, newWindow], serverNow),
        updated_at: now,
      };
      return { doc };
    }

    case "cancel_window": {
      const idx = current.windows.findIndex((w) => w.id === payload.window_id);
      if (idx === -1) return { error: `Window "${payload.window_id}" not found.` };
      if (current.windows[idx].status === "cancelled") {
        return { error: "Window is already cancelled." };
      }
      const updated = current.windows.map((w) =>
        w.id === payload.window_id
          ? { ...w, status: "cancelled" as const, updated_at: now }
          : w,
      );
      const doc: SystemStatusDocument = {
        ...current,
        revision: rev,
        windows: pruneOldWindows(updated, serverNow),
        updated_at: now,
      };
      return { doc };
    }

    case "publish_announcement": {
      const doc: SystemStatusDocument = {
        ...current,
        revision: rev,
        announcement: {
          id: rev,
          title: payload.title,
          message: payload.message,
          published_at: now,
          updated_at: now,
        },
        updated_at: now,
      };
      return { doc };
    }

    case "clear_announcement": {
      const doc: SystemStatusDocument = {
        ...current,
        revision: rev,
        announcement: null,
        updated_at: now,
      };
      return { doc };
    }

    default:
      return { error: "Unknown action" };
  }
}

/**
 * In-memory store used when Edge Config is unavailable.
 * Starts from the default document. State is per-process and resets on cold start.
 */
export class InMemorySystemStatusStore implements SystemStatusStore {
  private doc: SystemStatusDocument;

  constructor(initial?: SystemStatusDocument) {
    this.doc = initial ?? defaultStatusDocument();
  }

  async read(): Promise<StoreReadResult> {
    return { ok: true, doc: structuredClone(this.doc) };
  }

  async write(
    payload: MaintenanceWritePayload,
    serverNow: Date,
  ): Promise<StoreWriteResult> {
    const result = applyWrite(this.doc, payload, serverNow);
    if ("error" in result) {
      return { ok: false, error: result.error, conflict: result.conflict };
    }
    this.doc = result.doc;
    return { ok: true, doc: structuredClone(this.doc) };
  }
}
