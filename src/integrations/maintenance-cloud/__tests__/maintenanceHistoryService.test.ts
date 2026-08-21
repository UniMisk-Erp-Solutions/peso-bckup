import { describe, expect, it, vi, beforeEach } from "vitest";

let onAwait: () => Promise<{ data: unknown; error: unknown; count?: number | null }>;
const rangeCalls: unknown[][] = [];
const eqCalls: unknown[][] = [];

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  builder.eq = vi.fn((...args: unknown[]) => {
    eqCalls.push(args);
    return builder;
  });
  builder.order = vi.fn(() => builder);
  builder.gte = vi.fn(() => builder);
  builder.lte = vi.fn(() => builder);
  builder.range = vi.fn((...args: unknown[]) => {
    rangeCalls.push(args);
    return builder;
  });
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    onAwait().then(resolve, reject);
  return builder;
}

const select = vi.fn((_cols: string, _opts?: unknown) => makeBuilder());
const from = vi.fn(() => ({ select }));

let mockClient: { from: typeof from } | null = { from };

vi.mock("../client", () => ({
  getMaintenanceSupabase: () => mockClient,
}));

import { readMaintenanceHistory, MAINTENANCE_HISTORY_PAGE_SIZE } from "../maintenanceHistoryService";

const ROW = {
  id: "hist-1",
  environment: "preview",
  kind: "scheduled",
  title: "QA",
  message: null,
  scheduled_start_at: "2026-08-15T11:00:00Z",
  scheduled_end_at: "2026-08-15T12:00:00Z",
  actual_started_at: null,
  actual_ended_at: null,
  cancelled_at: null,
  created_at: "2026-08-15T10:00:00Z",
  created_by: "owner-uuid",
  updated_at: "2026-08-15T10:00:00Z",
  updated_by: "owner-uuid",
};

beforeEach(() => {
  from.mockClear();
  select.mockClear();
  rangeCalls.length = 0;
  eqCalls.length = 0;
  mockClient = { from };
});

describe("readMaintenanceHistory", () => {
  it("returns an error when the Cloud client is not configured", async () => {
    mockClient = null;
    const result = await readMaintenanceHistory({ environment: "preview", page: 1 });
    expect(result.ok).toBe(false);
  });

  it("returns rows, totalCount, page, and pageSize on success", async () => {
    onAwait = async () => ({ data: [ROW], error: null, count: 1 });
    const result = await readMaintenanceHistory({ environment: "preview", page: 1 });
    expect(result).toEqual({
      ok: true,
      rows: [ROW],
      totalCount: 1,
      page: 1,
      pageSize: MAINTENANCE_HISTORY_PAGE_SIZE,
    });
  });

  it("defaults to a 20-row page size and never fetches unlimited history", async () => {
    onAwait = async () => ({ data: [], error: null, count: 0 });
    await readMaintenanceHistory({ environment: "preview", page: 1 });
    expect(rangeCalls[0]).toEqual([0, MAINTENANCE_HISTORY_PAGE_SIZE - 1]);
  });

  it("computes the correct range for page 2", async () => {
    onAwait = async () => ({ data: [], error: null, count: 0 });
    await readMaintenanceHistory({ environment: "preview", page: 2, pageSize: 10 });
    expect(rangeCalls[0]).toEqual([10, 19]);
  });

  it("filters by environment", async () => {
    onAwait = async () => ({ data: [], error: null, count: 0 });
    await readMaintenanceHistory({ environment: "production", page: 1 });
    expect(eqCalls).toContainEqual(["environment", "production"]);
  });

  it("filters by kind when provided", async () => {
    onAwait = async () => ({ data: [], error: null, count: 0 });
    await readMaintenanceHistory({ environment: "preview", page: 1, kind: "forced" });
    expect(eqCalls).toContainEqual(["kind", "forced"]);
  });

  it("surfaces a query error rather than throwing", async () => {
    onAwait = async () => ({ data: null, error: { message: "boom" }, count: null });
    const result = await readMaintenanceHistory({ environment: "preview", page: 1 });
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});
