/**
 * Read path must never retry, never log secrets, and always resolve to a
 * structured MaintenanceReadOutcome — never throw. See
 * docs/maintenance/CLOUD_MAINTENANCE_CONTROL_PLANE.md §14.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// A postgrest-like thenable builder whose resolution we control per test —
// same pattern already used in this codebase for reviewQueueServer/api.ts's
// abortSignal-chained calls (see callRpcAbortHardening.test.ts).
let onAwait: () => Promise<{ data: unknown; error: unknown; status?: number }>;
const abortSignal = vi.fn(function (this: unknown) {
  return this;
});
const eq = vi.fn(function (this: unknown) {
  return this;
});
const select = vi.fn(() => {
  const builder = {
    eq,
    abortSignal,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      onAwait().then(resolve, reject),
  };
  eq.mockReturnValue(builder);
  abortSignal.mockReturnValue(builder);
  return builder;
});
const from = vi.fn(() => ({ select }));

let mockClient: { from: typeof from } | null = { from };

vi.mock("../client", () => ({
  getMaintenanceSupabase: () => mockClient,
  isMaintenanceCloudConfigured: () => mockClient !== null,
}));

import { fetchMaintenanceStatus } from "../maintenanceStatusService";

const VALID_ROW = {
  environment: "production",
  force_maintenance: false,
  title: null,
  message: null,
  starts_at: null,
  ends_at: null,
  updated_at: "2026-08-15T00:00:00.000Z",
  updated_by: null,
};

beforeEach(() => {
  from.mockClear();
  select.mockClear();
  eq.mockClear();
  abortSignal.mockClear();
  mockClient = { from };
});

describe("fetchMaintenanceStatus — fail-open I/O boundary", () => {
  it("invalid environment fails open WITHOUT making any request", async () => {
    const outcome = await fetchMaintenanceStatus("staging", 2500);
    expect(outcome).toEqual({ kind: "invalid_environment" });
    expect(from).not.toHaveBeenCalled();
  });

  it("undefined environment fails open without a request", async () => {
    const outcome = await fetchMaintenanceStatus(undefined, 2500);
    expect(outcome).toEqual({ kind: "invalid_environment" });
    expect(from).not.toHaveBeenCalled();
  });

  it("unconfigured client fails open without a request", async () => {
    mockClient = null;
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "not_configured" });
    expect(from).not.toHaveBeenCalled();
  });

  it("a single valid row resolves to success", async () => {
    onAwait = async () => ({ data: [VALID_ROW], error: null });
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "success", row: VALID_ROW });
  });

  it("zero rows fails open (no_rows)", async () => {
    onAwait = async () => ({ data: [], error: null });
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "no_rows" });
  });

  it("more than one row fails open (multiple_rows) — should be impossible under the PK, but never trusted", async () => {
    onAwait = async () => ({ data: [VALID_ROW, VALID_ROW], error: null });
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "multiple_rows" });
  });

  it("a malformed row shape fails open (malformed)", async () => {
    onAwait = async () => ({ data: [{ nope: true }], error: null });
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "malformed" });
  });

  it("a non-array body fails open (malformed)", async () => {
    onAwait = async () => ({ data: { not: "an array" }, error: null });
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "malformed" });
  });

  it("a PostgREST error (e.g. paused/unreachable project) fails open (http_error)", async () => {
    onAwait = async () => ({ data: null, error: { message: "fetch failed" }, status: 503 });
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "http_error", status: 503 });
  });

  it("a thrown network error fails open (network_error), never throws out of the function", async () => {
    onAwait = async () => {
      throw new TypeError("Failed to fetch");
    };
    const outcome = await fetchMaintenanceStatus("production", 2500);
    expect(outcome).toEqual({ kind: "network_error" });
  });

  it("an aborted (timed-out) request fails open (timeout)", async () => {
    // Never resolves on its own — only the AbortController's own timeout
    // (driven by fetchMaintenanceStatus's setTimeout) rejects it, exactly
    // like a real hung request whose fetch is cancelled mid-flight. Reads
    // the signal from abortSignal.mock.calls (recorded synchronously before
    // `then`/onAwait runs) rather than overriding the shared mock's
    // implementation, which select() itself re-assigns on every call via
    // mockReturnValue and would otherwise clobber a mockImplementation set
    // here.
    onAwait = () =>
      new Promise((_resolve, reject) => {
        const lastCall = abortSignal.mock.calls[abortSignal.mock.calls.length - 1];
        const signal = lastCall?.[0] as AbortSignal;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const outcome = await fetchMaintenanceStatus("production", 5);
    expect(outcome).toEqual({ kind: "timeout" });
  });

  it("passes an AbortSignal bounded by the configured timeout, and never retries (one call per invocation)", async () => {
    onAwait = async () => ({ data: [VALID_ROW], error: null });
    await fetchMaintenanceStatus("production", 2500);
    expect(from).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(abortSignal).toHaveBeenCalledTimes(1);
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it("selects only the required columns, never select(*)", async () => {
    onAwait = async () => ({ data: [VALID_ROW], error: null });
    await fetchMaintenanceStatus("production", 2500);
    const columns = select.mock.calls[0][0] as string;
    expect(columns).not.toContain("*");
    expect(columns).toContain("force_maintenance");
    expect(columns).toContain("environment");
  });

  it("filters by the requested environment", async () => {
    onAwait = async () => ({ data: [VALID_ROW], error: null });
    await fetchMaintenanceStatus("preview", 2500);
    expect(eq).toHaveBeenCalledWith("environment", "preview");
  });
});
