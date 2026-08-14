import { describe, expect, it, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import { fetchManagerOverrideCapability } from "@/lib/reviewManagerOverrideCapability";

beforeEach(() => rpc.mockReset());

describe("fetchManagerOverrideCapability — fail closed", () => {
  it("true only when the RPC reports the right contract and ready", async () => {
    rpc.mockResolvedValue({
      data: { contract: "review-manager-override", version: 1, ready: true },
      error: null,
    });
    expect(await fetchManagerOverrideCapability()).toBe(true);
  });

  it("false when ready is false (migration not applied)", async () => {
    rpc.mockResolvedValue({
      data: { contract: "review-manager-override", version: 1, ready: false },
      error: null,
    });
    expect(await fetchManagerOverrideCapability()).toBe(false);
  });

  it("false when the RPC is absent (PGRST202 error)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    expect(await fetchManagerOverrideCapability()).toBe(false);
  });

  it("false when the contract does not match", async () => {
    rpc.mockResolvedValue({ data: { contract: "something-else", ready: true }, error: null });
    expect(await fetchManagerOverrideCapability()).toBe(false);
  });

  it("false when the RPC returns a transport error object", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "network" } });
    expect(await fetchManagerOverrideCapability()).toBe(false);
  });
});
