import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc, from } }));

import {
  TALLY_CONNECTOR_ONLINE_MS,
  buildConnectorPairCommand,
  fetchTallyPendingBatches,
  isConnectorDeviceOnline,
  quarantineTallyPendingBatches,
} from "../tallyConnectorCloud";

describe("tallyConnectorCloud", () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  it("online window", () => {
    const now = Date.now();
    expect(isConnectorDeviceOnline(new Date(now - TALLY_CONNECTOR_ONLINE_MS + 1000).toISOString(), now)).toBe(true);
    expect(isConnectorDeviceOnline(new Date(now - TALLY_CONNECTOR_ONLINE_MS - 1000).toISOString(), now)).toBe(false);
    expect(isConnectorDeviceOnline(null, now)).toBe(false);
  });

  it("builds pair command with company", () => {
    const cmd = buildConnectorPairCommand({
      supabaseUrl: "https://example.test",
      anonKey: "anon",
      pairingCode: "ABCD1234",
      companyName: "PesoWise Integration Test",
    });
    expect(cmd).toContain("pair --url https://example.test");
    expect(cmd).toContain("--code ABCD1234");
    expect(cmd).toContain('--company "PesoWise Integration Test"');
  });

  it("requests newest pending batches first so recent jobs survive the REST row cap", async () => {
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      order: vi.fn(() => query),
      range: vi.fn(() => query),
      limit: vi.fn(() => query),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    from.mockReturnValueOnce(query);

    await fetchTallyPendingBatches("org-1");

    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(query.range).toHaveBeenCalledWith(0, 999);
    expect(query.limit).not.toHaveBeenCalled();
  });

  it("quarantines only unique, non-empty batch IDs through the authenticated admin RPC", async () => {
    rpc.mockResolvedValue({ data: { updated: 2 }, error: null });
    await quarantineTallyPendingBatches("org-1", ["batch-1", " batch-1 ", "batch-2"], "Explicit test quarantine reason.");
    expect(rpc).toHaveBeenCalledWith("admin_quarantine_tally_delivery_batches_v1", {
      p_organization_id: "org-1",
      p_batch_ids: ["batch-1", "batch-2"],
      p_reason: "Explicit test quarantine reason.",
    });
  });

  it("fails closed on invalid input, RPC errors, and partial quarantine results", async () => {
    await expect(quarantineTallyPendingBatches("org-1", [], "Valid quarantine explanation."))
      .rejects.toThrow("Organization and pending batch IDs are required");
    await expect(quarantineTallyPendingBatches("org-1", ["batch-1"], "short"))
      .rejects.toThrow("Quarantine reason must explain why delivery is blocked");
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce({ data: null, error: { message: "not permitted" } });
    await expect(quarantineTallyPendingBatches("org-1", ["batch-1"], "Explicit test quarantine reason."))
      .rejects.toThrow("not permitted");

    rpc.mockResolvedValueOnce({ data: { updated: 0 }, error: null });
    await expect(quarantineTallyPendingBatches("org-1", ["batch-1"], "Explicit test quarantine reason."))
      .rejects.toThrow("Quarantine updated 0 of 1 selected batches");
  });
});
