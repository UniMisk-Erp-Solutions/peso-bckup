/**
 * Tests for the pure system status evaluator (no I/O, no mocks needed).
 * Coverage: tests 1–15 from Phase A spec.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateSystemStatus,
  getActiveScheduledWindow,
  getNextUpcomingWindow,
  isInAnnouncementPeriod,
  pruneOldWindows,
  validateWindow,
  validateManualMaintenance,
  MAX_EXPIRED_WINDOWS,
} from "../../../api/_lib/systemStatusEvaluator";
import { defaultStatusDocument } from "../../../api/_lib/systemStatusTypes";
import type { SystemStatusDocument, MaintenanceWindow } from "../../../api/_lib/systemStatusTypes";

const HEALTHY = { status: "healthy" as const, checked_at: "2026-07-16T10:00:00Z" };
const UNREACHABLE = { status: "unreachable" as const, checked_at: "2026-07-16T10:00:00Z" };
const DEGRADED_HEALTH = { status: "degraded" as const, checked_at: "2026-07-16T10:00:00Z" };

function makeCtx(nowIso: string, health = HEALTHY) {
  return { serverNow: new Date(nowIso), backendHealth: health, publicStatusUrl: null };
}

function makeWindow(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  return {
    id: "win-1",
    title: "Scheduled Maintenance",
    message: "We will be down for maintenance.",
    starts_at: "2026-07-16T14:00:00Z",
    ends_at: "2026-07-16T16:00:00Z",
    announce_from: "2026-07-16T12:00:00Z",
    status: "scheduled",
    created_at: "2026-07-16T10:00:00Z",
    updated_at: "2026-07-16T10:00:00Z",
    ...overrides,
  };
}

// T1 — operational with no windows
describe("evaluateSystemStatus", () => {
  it("T1: returns operational when document is empty and backend is healthy", () => {
    const doc = defaultStatusDocument();
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z"));
    expect(result.state).toBe("operational");
    expect(result.blocking).toBe(false);
    expect(result.source).toBe("none");
    expect(result.title).toBeNull();
  });

  // T2 — manual maintenance active
  it("T2: returns maintenance with blocking=true when manual_maintenance is enabled", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      manual_maintenance: {
        enabled: true,
        incident_id: "inc-1",
        title: "Emergency Maintenance",
        message: "We are investigating a critical issue.",
        started_at: "2026-07-16T10:00:00Z",
        estimated_end_at: "2026-07-16T12:00:00Z",
      },
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T11:00:00Z"));
    expect(result.state).toBe("maintenance");
    expect(result.blocking).toBe(true);
    expect(result.source).toBe("manual");
    expect(result.title).toBe("Emergency Maintenance");
    expect(result.estimated_end_at).toBe("2026-07-16T12:00:00Z");
  });

  // T3 — manual takes precedence over scheduled window
  it("T3: manual maintenance takes precedence over active scheduled window", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
      manual_maintenance: {
        enabled: true,
        incident_id: "inc-2",
        title: "Unplanned Outage",
        message: "Investigating.",
        started_at: "2026-07-16T13:00:00Z",
        estimated_end_at: null,
      },
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T14:30:00Z"));
    expect(result.source).toBe("manual");
    expect(result.state).toBe("maintenance");
  });

  // T4 — active scheduled window
  it("T4: returns maintenance when now is within a scheduled window", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T15:00:00Z"));
    expect(result.state).toBe("maintenance");
    expect(result.blocking).toBe(true);
    expect(result.source).toBe("scheduled");
    expect(result.starts_at).toBe("2026-07-16T14:00:00Z");
    expect(result.ends_at).toBe("2026-07-16T16:00:00Z");
  });

  // T5 — scheduled window not yet started but within announcement
  it("T5: returns upcoming when within announcement period", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T12:30:00Z"));
    expect(result.state).toBe("upcoming");
    expect(result.blocking).toBe(false);
    expect(result.source).toBe("scheduled");
    expect(result.next_window).not.toBeNull();
  });

  // T6 — before announcement period (future window, not yet announcing)
  it("T6: returns operational when upcoming window is before announce_from", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
    };
    // 1 hour before announce_from = 11:00, which is before 12:00
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T11:00:00Z"));
    expect(result.state).toBe("operational");
    expect(result.next_window).not.toBeNull();
    expect(result.next_window?.id).toBe("win-1");
  });

  // T7 — after window ends (expired)
  it("T7: returns operational when window has ended", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T16:30:00Z"));
    expect(result.state).toBe("operational");
  });

  // T8 — backend unreachable → operational (automatic outage detection removed)
  it("T8: returns operational even when backend health is unreachable (auto-detection removed)", () => {
    const doc = defaultStatusDocument();
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z", UNREACHABLE));
    expect(result.state).toBe("operational");
    expect(result.blocking).toBe(false);
    expect(result.source).not.toBe("automatic_health");
  });

  // T9 — backend degraded → operational (automatic degraded detection removed)
  it("T9: returns operational even when backend health is degraded (auto-detection removed)", () => {
    const doc = defaultStatusDocument();
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z", DEGRADED_HEALTH));
    expect(result.state).toBe("operational");
    expect(result.blocking).toBe(false);
    expect(result.source).not.toBe("automatic_health");
  });

  // T10 — manual maintenance takes precedence over unreachable
  it("T10: manual maintenance takes precedence over automatic unreachable", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      manual_maintenance: {
        enabled: true,
        incident_id: "inc-3",
        title: "Manual",
        message: "In progress.",
        started_at: "2026-07-16T09:00:00Z",
        estimated_end_at: null,
      },
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z", UNREACHABLE));
    expect(result.source).toBe("manual");
    expect(result.state).toBe("maintenance");
  });

  // T11 — cancelled window is ignored
  it("T11: cancelled window is not treated as active", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow({ status: "cancelled" })],
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T15:00:00Z"));
    expect(result.state).toBe("operational");
  });

  // T12 — exact boundary: now === ends_at is treated as after the window
  it("T12: now === ends_at is treated as ended (exclusive end)", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T16:00:00Z"));
    expect(result.state).toBe("operational");
  });

  // T13 — exact boundary: now === starts_at is treated as active
  it("T13: now === starts_at is treated as active window", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T14:00:00Z"));
    expect(result.state).toBe("maintenance");
  });

  // T14 — next_window present in operational state
  it("T14: next_window populated in operational state for future scheduled windows", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      windows: [makeWindow()],
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T11:00:00Z"));
    expect(result.next_window?.id).toBe("win-1");
    expect(result.next_window?.starts_at).toBe("2026-07-16T14:00:00Z");
  });

  // T15 — public_status_url is forwarded
  it("T15: public_status_url is forwarded from context", () => {
    const doc = defaultStatusDocument();
    const result = evaluateSystemStatus(doc, {
      ...makeCtx("2026-07-16T10:00:00Z"),
      publicStatusUrl: "https://status.example.com",
    });
    expect(result.public_status_url).toBe("https://status.example.com");
  });
});

// T16 — pruneOldWindows keeps only MAX_EXPIRED_WINDOWS
describe("pruneOldWindows", () => {
  it("T16: keeps at most MAX_EXPIRED_WINDOWS expired windows", () => {
    const now = new Date("2026-07-17T00:00:00Z");
    const expired: MaintenanceWindow[] = Array.from({ length: 25 }, (_, i) => ({
      id: `exp-${i}`,
      title: `Expired ${i}`,
      message: "old",
      starts_at: "2026-07-14T10:00:00Z",
      ends_at: "2026-07-14T12:00:00Z",
      announce_from: "2026-07-14T08:00:00Z",
      status: "scheduled" as const,
      created_at: "2026-07-14T08:00:00Z",
      updated_at: `2026-07-14T${String(10 + i).padStart(2, "0")}:00:00Z`,
    }));
    const result = pruneOldWindows(expired, now);
    expect(result.length).toBe(MAX_EXPIRED_WINDOWS);
  });

  it("T17: active windows are preserved regardless of count", () => {
    const now = new Date("2026-07-16T10:00:00Z");
    const active = makeWindow({
      id: "active-1",
      starts_at: "2026-07-16T14:00:00Z",
      ends_at: "2026-07-16T16:00:00Z",
    });
    const result = pruneOldWindows([active], now);
    expect(result.some((w) => w.id === "active-1")).toBe(true);
  });
});

// T18–T19 — validateWindow
describe("validateWindow", () => {
  const base = {
    title: "Planned Maintenance",
    message: "Brief downtime.",
    starts_at: "2026-07-20T10:00:00Z",
    ends_at: "2026-07-20T12:00:00Z",
    announce_from: "2026-07-20T08:00:00Z",
  };

  it("T18: returns null for a valid window with no overlaps", () => {
    expect(validateWindow(base, [])).toBeNull();
  });

  it("T19: returns error when end <= start", () => {
    const err = validateWindow({ ...base, ends_at: base.starts_at }, []);
    expect(err).toMatch(/End time must be after/i);
  });

  it("T20: returns error when announce_from > starts_at", () => {
    const err = validateWindow({ ...base, announce_from: "2026-07-20T11:00:00Z" }, []);
    expect(err).toMatch(/Announcement time must be at or before/i);
  });

  it("T21: returns overlap error when windows collide", () => {
    const existing = makeWindow({
      starts_at: "2026-07-20T09:00:00Z",
      ends_at: "2026-07-20T11:00:00Z",
    });
    const err = validateWindow(base, [existing]);
    expect(err).toMatch(/Overlaps with/i);
  });
});

// T22 — validateManualMaintenance
describe("validateManualMaintenance", () => {
  it("T22: returns null for valid payload", () => {
    expect(
      validateManualMaintenance({
        title: "Emergency",
        message: "Investigating now.",
        estimated_end_at: null,
      }),
    ).toBeNull();
  });

  it("T23: returns error when title is empty", () => {
    const err = validateManualMaintenance({ title: "", message: "ok", estimated_end_at: null });
    expect(err).toMatch(/Title is required/i);
  });
});

// T24 — getActiveScheduledWindow
describe("getActiveScheduledWindow", () => {
  it("T24: returns null when no windows", () => {
    expect(getActiveScheduledWindow([], new Date("2026-07-16T10:00:00Z"))).toBeNull();
  });
});

// T25 — isInAnnouncementPeriod
describe("isInAnnouncementPeriod", () => {
  it("T25: returns true when now is between announce_from and starts_at", () => {
    const w = makeWindow();
    expect(isInAnnouncementPeriod(w, new Date("2026-07-16T13:00:00Z"))).toBe(true);
  });

  it("T26: returns false when now is before announce_from", () => {
    const w = makeWindow();
    expect(isInAnnouncementPeriod(w, new Date("2026-07-16T11:00:00Z"))).toBe(false);
  });
});

// T27–T30 — active_announcement in evaluator output
describe("evaluateSystemStatus — active_announcement", () => {
  const ANN = {
    id: "ann-1",
    title: "Delay tonight",
    message: "Reports delayed.",
    published_at: "2026-07-16T08:00:00Z",
    updated_at: "2026-07-16T08:00:00Z",
  };

  it("T27: active_announcement is null when doc has no announcement", () => {
    const doc = defaultStatusDocument();
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z"));
    expect(result.active_announcement).toBeNull();
  });

  it("T28: active_announcement is populated in operational state", () => {
    const doc = { ...defaultStatusDocument(), announcement: ANN };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z"));
    expect(result.state).toBe("operational");
    expect(result.active_announcement).not.toBeNull();
    expect(result.active_announcement?.id).toBe("ann-1");
    expect(result.active_announcement?.title).toBe("Delay tonight");
  });

  it("T29: active_announcement is present even during manual maintenance", () => {
    const doc: SystemStatusDocument = {
      ...defaultStatusDocument(),
      announcement: ANN,
      manual_maintenance: {
        enabled: true,
        incident_id: "inc-1",
        title: "Emergency",
        message: "Down now.",
        started_at: "2026-07-16T09:00:00Z",
        estimated_end_at: null,
      },
    };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z"));
    expect(result.state).toBe("maintenance");
    expect(result.active_announcement?.id).toBe("ann-1");
  });

  it("T30: active_announcement is absent when announcement field is null", () => {
    const doc = { ...defaultStatusDocument(), announcement: null };
    const result = evaluateSystemStatus(doc, makeCtx("2026-07-16T10:00:00Z"));
    expect(result.active_announcement).toBeNull();
  });
});
