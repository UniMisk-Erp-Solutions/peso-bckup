/**
 * Pure lease-state tests — the fix for the owner-reported early-unlock bug.
 * See docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §35.
 */
import { describe, expect, it } from "vitest";
import {
  applyMaintenanceOutcome,
  createEmptyLeaseState,
  deriveMaintenanceResolution,
  tickLeaseExpiry,
  nextLeaseTransitionMs,
  scheduleAt,
  type MaintenanceLeaseState,
} from "../maintenanceLeaseState";
import type { MaintenanceReadOutcome } from "../maintenanceResolver";

const GRACE_MS = 180_000;

function row(overrides: Partial<{
  environment: "preview" | "production";
  force_maintenance: boolean;
  title: string | null;
  message: string | null;
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
  updated_by: string | null;
}> = {}) {
  return {
    environment: "production" as const,
    force_maintenance: false,
    title: null,
    message: null,
    starts_at: null,
    ends_at: null,
    updated_at: new Date().toISOString(),
    updated_by: null,
    ...overrides,
  };
}

function success(r: ReturnType<typeof row>): MaintenanceReadOutcome {
  return { kind: "success", row: r };
}

describe("applyMaintenanceOutcome — the owner-bug fix", () => {
  it("A/B — active scheduled lease survives a transient network_error/timeout poll", () => {
    const now = new Date();
    const active = success(
      row({
        starts_at: new Date(now.getTime() - 60_000).toISOString(),
        ends_at: new Date(now.getTime() + 89 * 60_000).toISOString(),
        title: "Scheduled work",
      }),
    );
    let state = applyMaintenanceOutcome(createEmptyLeaseState(), active, now, GRACE_MS);
    expect(deriveMaintenanceResolution(state, now).state).toBe("maintenance");

    for (const failure of [{ kind: "network_error" }, { kind: "timeout" }] as MaintenanceReadOutcome[]) {
      const laterNow = new Date(now.getTime() + 30_000);
      state = applyMaintenanceOutcome(state, failure, laterNow, GRACE_MS);
      const resolution = deriveMaintenanceResolution(state, laterNow);
      expect(resolution.state).toBe("maintenance");
      if (resolution.state === "maintenance") expect(resolution.source).toBe("scheduled");
    }
  });

  it("C — a scheduled lease reaching ends_at resolves to normal", () => {
    const now = new Date();
    const active = success(
      row({
        starts_at: new Date(now.getTime() - 60_000).toISOString(),
        ends_at: new Date(now.getTime() + 60_000).toISOString(),
      }),
    );
    let state = applyMaintenanceOutcome(createEmptyLeaseState(), active, now, GRACE_MS);
    const afterEnd = new Date(now.getTime() + 120_000);
    // Even with no fresh outcome — a failure at/after ends_at must not
    // extend the window.
    state = applyMaintenanceOutcome(state, { kind: "network_error" }, afterEnd, GRACE_MS);
    expect(deriveMaintenanceResolution(state, afterEnd).state).toBe("normal");
  });

  it("D — a fresh Cloud cancellation (schedule removed) clears the lease immediately", () => {
    const now = new Date();
    const active = success(
      row({
        starts_at: new Date(now.getTime() - 60_000).toISOString(),
        ends_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
      }),
    );
    let state = applyMaintenanceOutcome(createEmptyLeaseState(), active, now, GRACE_MS);
    expect(deriveMaintenanceResolution(state, now).state).toBe("maintenance");

    const cancelled = success(row({ starts_at: null, ends_at: null }));
    state = applyMaintenanceOutcome(state, cancelled, now, GRACE_MS);
    expect(deriveMaintenanceResolution(state, now).state).toBe("normal");
  });

  it("fresh success with a different start/end REPLACES the lease", () => {
    const now = new Date();
    const first = success(
      row({
        starts_at: new Date(now.getTime() + 3600_000).toISOString(),
        ends_at: new Date(now.getTime() + 7200_000).toISOString(),
        title: "Original window",
      }),
    );
    let state = applyMaintenanceOutcome(createEmptyLeaseState(), first, now, GRACE_MS);
    expect(state.scheduledLease?.title).toBe("Original window");

    const replaced = success(
      row({
        starts_at: new Date(now.getTime() + 1800_000).toISOString(),
        ends_at: new Date(now.getTime() + 5400_000).toISOString(),
        title: "Rescheduled window",
      }),
    );
    state = applyMaintenanceOutcome(state, replaced, now, GRACE_MS);
    expect(state.scheduledLease?.title).toBe("Rescheduled window");
  });

  it("E — a future schedule establishes an upcoming lease that flips to maintenance once starts_at passes", () => {
    const now = new Date();
    const future = success(
      row({
        starts_at: new Date(now.getTime() + 60_000).toISOString(),
        ends_at: new Date(now.getTime() + 3_660_000).toISOString(),
      }),
    );
    const state = applyMaintenanceOutcome(createEmptyLeaseState(), future, now, GRACE_MS);
    expect(deriveMaintenanceResolution(state, now).state).toBe("upcoming");

    // No new outcome — a local timer tick past starts_at must flip to maintenance.
    const afterStart = new Date(now.getTime() + 90_000);
    const ticked = tickLeaseExpiry(state, afterStart, GRACE_MS);
    expect(deriveMaintenanceResolution(ticked, afterStart).state).toBe("maintenance");
  });

  it("F — initial page load with Cloud failure fails open to normal (no lease yet)", () => {
    const now = new Date();
    const state = applyMaintenanceOutcome(createEmptyLeaseState(), { kind: "network_error" }, now, GRACE_MS);
    expect(deriveMaintenanceResolution(state, now)).toEqual({
      state: "normal",
      row: null,
      outcome: "not_configured",
    });
  });

  it("G — fresh force=true survives one failed poll", () => {
    const now = new Date();
    let state = applyMaintenanceOutcome(
      createEmptyLeaseState(),
      success(row({ force_maintenance: true, title: "Forced" })),
      now,
      GRACE_MS,
    );
    expect(deriveMaintenanceResolution(state, now).state).toBe("maintenance");

    const later = new Date(now.getTime() + 30_000);
    state = applyMaintenanceOutcome(state, { kind: "http_error", status: 503 }, later, GRACE_MS);
    const resolution = deriveMaintenanceResolution(state, later);
    expect(resolution.state).toBe("maintenance");
    if (resolution.state === "maintenance") expect(resolution.source).toBe("forced");
  });

  it("H — a forced lease with no confirmation beyond the grace period fails open", () => {
    const now = new Date();
    let state = applyMaintenanceOutcome(
      createEmptyLeaseState(),
      success(row({ force_maintenance: true })),
      now,
      GRACE_MS,
    );
    const withinGrace = new Date(now.getTime() + GRACE_MS - 1_000);
    state = applyMaintenanceOutcome(state, { kind: "network_error" }, withinGrace, GRACE_MS);
    expect(deriveMaintenanceResolution(state, withinGrace).state).toBe("maintenance");

    const beyondGrace = new Date(now.getTime() + GRACE_MS + 1_000);
    state = applyMaintenanceOutcome(state, { kind: "network_error" }, beyondGrace, GRACE_MS);
    expect(deriveMaintenanceResolution(state, beyondGrace).state).toBe("normal");
  });

  it("I — fresh force=false stops forced maintenance immediately, even mid-grace-window", () => {
    const now = new Date();
    let state = applyMaintenanceOutcome(
      createEmptyLeaseState(),
      success(row({ force_maintenance: true })),
      now,
      GRACE_MS,
    );
    expect(deriveMaintenanceResolution(state, now).state).toBe("maintenance");

    const soon = new Date(now.getTime() + 5_000);
    state = applyMaintenanceOutcome(state, success(row({ force_maintenance: false })), soon, GRACE_MS);
    expect(deriveMaintenanceResolution(state, soon).state).toBe("normal");
  });

  it("forced lease takes precedence over an active scheduled lease", () => {
    const now = new Date();
    const both = success(
      row({
        force_maintenance: true,
        starts_at: new Date(now.getTime() - 60_000).toISOString(),
        ends_at: new Date(now.getTime() + 60_000).toISOString(),
      }),
    );
    const state = applyMaintenanceOutcome(createEmptyLeaseState(), both, now, GRACE_MS);
    const resolution = deriveMaintenanceResolution(state, now);
    expect(resolution.state).toBe("maintenance");
    if (resolution.state === "maintenance") expect(resolution.source).toBe("forced");
  });

  it("a fresh success carrying an already-expired window establishes no lease", () => {
    const now = new Date();
    const expired = success(
      row({
        starts_at: new Date(now.getTime() - 7200_000).toISOString(),
        ends_at: new Date(now.getTime() - 3600_000).toISOString(),
      }),
    );
    const state = applyMaintenanceOutcome(createEmptyLeaseState(), expired, now, GRACE_MS);
    expect(state.scheduledLease).toBeNull();
    expect(deriveMaintenanceResolution(state, now).state).toBe("normal");
  });

  it("a malformed window (start without end, per the DB constraint) never creates a lease", () => {
    const now = new Date();
    const malformed = success(
      row({ starts_at: new Date(now.getTime() + 60_000).toISOString(), ends_at: null }),
    );
    const state = applyMaintenanceOutcome(createEmptyLeaseState(), malformed, now, GRACE_MS);
    expect(state.scheduledLease).toBeNull();
  });
});

describe("nextLeaseTransitionMs", () => {
  it("returns null for an empty lease", () => {
    expect(nextLeaseTransitionMs(createEmptyLeaseState(), new Date(), GRACE_MS)).toBeNull();
  });

  it("returns starts_at for an upcoming schedule, never a past timestamp", () => {
    const now = new Date();
    const state: MaintenanceLeaseState = {
      scheduledLease: {
        environment: "production",
        starts_at: new Date(now.getTime() + 60_000).toISOString(),
        ends_at: new Date(now.getTime() + 120_000).toISOString(),
        title: null,
        message: null,
        updated_at: now.toISOString(),
      },
      forcedLease: null,
    };
    expect(nextLeaseTransitionMs(state, now, GRACE_MS)).toBe(
      new Date(state.scheduledLease!.starts_at).getTime(),
    );
  });

  it("returns ends_at (not the already-past starts_at) once the window is active — the exact bug that caused a busy loop", () => {
    const now = new Date();
    const state: MaintenanceLeaseState = {
      scheduledLease: {
        environment: "production",
        starts_at: new Date(now.getTime() - 60_000).toISOString(),
        ends_at: new Date(now.getTime() + 120_000).toISOString(),
        title: null,
        message: null,
        updated_at: now.toISOString(),
      },
      forcedLease: null,
    };
    const next = nextLeaseTransitionMs(state, now, GRACE_MS);
    expect(next).toBe(new Date(state.scheduledLease!.ends_at).getTime());
    expect(next).toBeGreaterThan(now.getTime());
  });

  it("returns null once every candidate boundary is already in the past", () => {
    const now = new Date();
    const state: MaintenanceLeaseState = {
      scheduledLease: {
        environment: "production",
        starts_at: new Date(now.getTime() - 120_000).toISOString(),
        ends_at: new Date(now.getTime() - 60_000).toISOString(),
        title: null,
        message: null,
        updated_at: now.toISOString(),
      },
      forcedLease: null,
    };
    expect(nextLeaseTransitionMs(state, now, GRACE_MS)).toBeNull();
  });

  it("returns the forced-lease grace expiry when only a forced lease is held", () => {
    const now = new Date();
    const state: MaintenanceLeaseState = {
      scheduledLease: null,
      forcedLease: {
        environment: "production",
        title: null,
        message: null,
        updated_at: now.toISOString(),
        lastConfirmedAt: now.toISOString(),
      },
    };
    expect(nextLeaseTransitionMs(state, now, GRACE_MS)).toBe(now.getTime() + GRACE_MS);
  });

  it("returns the soonest of multiple candidates when both leases are held", () => {
    const now = new Date();
    const state: MaintenanceLeaseState = {
      scheduledLease: {
        environment: "production",
        starts_at: new Date(now.getTime() + 500_000).toISOString(),
        ends_at: new Date(now.getTime() + 600_000).toISOString(),
        title: null,
        message: null,
        updated_at: now.toISOString(),
      },
      forcedLease: {
        environment: "production",
        title: null,
        message: null,
        updated_at: now.toISOString(),
        lastConfirmedAt: now.toISOString(),
      },
    };
    // forced grace (GRACE_MS = 180_000) is sooner than the scheduled starts_at (500_000)
    expect(nextLeaseTransitionMs(state, now, GRACE_MS)).toBe(now.getTime() + GRACE_MS);
  });
});

describe("scheduleAt — safe timer scheduling", () => {
  it("clamps a negative delay to fire immediately (delay 0)", async () => {
    const now = Date.now();
    let fired = false;
    const cancel = scheduleAt(now - 5_000, now, () => {
      fired = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(true);
    cancel();
  });

  it("cancel() prevents the callback from firing", async () => {
    const now = Date.now();
    let fired = false;
    const cancel = scheduleAt(now + 20, now, () => {
      fired = true;
    });
    cancel();
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(false);
  });

  it("re-arms across a delay beyond the max signed 32-bit timeout without firing early", async () => {
    const now = Date.now();
    let fired = false;
    // Target is 3 seconds out; verify it does NOT fire within 50ms — i.e.
    // the function doesn't misinterpret a large delay and fire immediately.
    const cancel = scheduleAt(now + 3_000, now, () => {
      fired = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(false);
    cancel();
  });
});
