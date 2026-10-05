/**
 * RELEASE-PREP §10/§21 — Historical Balance V2 backend capability probe.
 *
 * Mirrors reviewManagerOverrideCapability's contract: FAIL CLOSED on any
 * error (RPC missing/PGRST202, network failure, contract mismatch) and
 * cache the result at module scope so the RPC is never re-probed on every
 * render/mount -- exactly the request storm this idiom exists to avoid.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

async function importFresh() {
  vi.resetModules();
  return import("../balanceHistoricalV2Capability");
}

beforeEach(() => {
  rpcMock.mockReset();
});

describe("fetchBalanceHistoricalV2Capability — all present", () => {
  it("resolves ready=true when the server reports every function installed", async () => {
    rpcMock.mockResolvedValue({
      data: { contract: "balance-historical-v2", version: 1, ready: true, functions: { a: true } },
      error: null,
    });
    const { fetchBalanceHistoricalV2Capability } = await importFresh();
    const result = await fetchBalanceHistoricalV2Capability();
    expect(result.ready).toBe(true);
    expect(result.functions).toEqual({ a: true });
  });
});

describe("fetchBalanceHistoricalV2Capability — fails closed", () => {
  it("resolves ready=false when the RPC errors (e.g. PGRST202, migration not applied)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "function not found" } });
    const { fetchBalanceHistoricalV2Capability } = await importFresh();
    const result = await fetchBalanceHistoricalV2Capability();
    expect(result.ready).toBe(false);
  });

  it("resolves ready=false when the RPC throws (network failure)", async () => {
    rpcMock.mockRejectedValue(new Error("network down"));
    const { fetchBalanceHistoricalV2Capability } = await importFresh();
    const result = await fetchBalanceHistoricalV2Capability();
    expect(result.ready).toBe(false);
  });

  it("resolves ready=false on a contract mismatch, even if the server claims ready=true", async () => {
    rpcMock.mockResolvedValue({
      data: { contract: "some-other-contract", ready: true },
      error: null,
    });
    const { fetchBalanceHistoricalV2Capability } = await importFresh();
    const result = await fetchBalanceHistoricalV2Capability();
    expect(result.ready).toBe(false);
  });

  it("resolves ready=false when the server itself reports ready=false", async () => {
    rpcMock.mockResolvedValue({
      data: { contract: "balance-historical-v2", ready: false, functions: { balance_apply_import_v2: false } },
      error: null,
    });
    const { fetchBalanceHistoricalV2Capability } = await importFresh();
    const result = await fetchBalanceHistoricalV2Capability();
    expect(result.ready).toBe(false);
  });
});

describe("fetchBalanceHistoricalV2Capability — no request storm", () => {
  it("probes the RPC only once across many concurrent/sequential calls (module-level cache)", async () => {
    rpcMock.mockResolvedValue({
      data: { contract: "balance-historical-v2", ready: true, functions: {} },
      error: null,
    });
    const { fetchBalanceHistoricalV2Capability } = await importFresh();

    const [a, b, c] = await Promise.all([
      fetchBalanceHistoricalV2Capability(),
      fetchBalanceHistoricalV2Capability(),
      fetchBalanceHistoricalV2Capability(),
    ]);
    await fetchBalanceHistoricalV2Capability();

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(a.ready).toBe(true);
    expect(b.ready).toBe(true);
    expect(c.ready).toBe(true);
  });

  it("a failed probe does not retry on every subsequent call in quick succession (no request storm)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const { fetchBalanceHistoricalV2Capability } = await importFresh();

    await fetchBalanceHistoricalV2Capability();
    await fetchBalanceHistoricalV2Capability();
    await fetchBalanceHistoricalV2Capability();

    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchBalanceHistoricalV2Capability -- a stuck false must self-heal once the backend becomes ready (Phase 12)", () => {
  it("retries after the negative-cache TTL elapses and picks up a newly-ready backend, without polling in between", async () => {
    vi.useFakeTimers();
    try {
      rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
      const { fetchBalanceHistoricalV2Capability, NEGATIVE_CACHE_TTL_MS } = await importFresh();

      const first = await fetchBalanceHistoricalV2Capability();
      expect(first.ready).toBe(false);
      expect(rpcMock).toHaveBeenCalledTimes(1);

      // Still within the TTL -- must NOT poll again, exactly like the
      // existing "no request storm" guarantee.
      vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS - 1);
      await fetchBalanceHistoricalV2Capability();
      expect(rpcMock).toHaveBeenCalledTimes(1);

      // The admin applies the Phase 1 migrations while this tab is still
      // open -- the backend is now genuinely ready.
      rpcMock.mockResolvedValue({
        data: { contract: "balance-historical-v2", ready: true, functions: { a: true } },
        error: null,
      });

      // Past the TTL -- the SAME tab, with no reload, must re-probe and see
      // the now-ready backend instead of staying stuck on the old `false`.
      vi.advanceTimersByTime(2);
      const afterHealed = await fetchBalanceHistoricalV2Capability();
      expect(rpcMock).toHaveBeenCalledTimes(2);
      expect(afterHealed.ready).toBe(true);

      // A definitive `true` result is cached for good -- no further probing.
      vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS * 10);
      await fetchBalanceHistoricalV2Capability();
      expect(rpcMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a `ready: true` result is never re-probed, even long after a `false` result would have expired", async () => {
    vi.useFakeTimers();
    try {
      rpcMock.mockResolvedValue({
        data: { contract: "balance-historical-v2", ready: true, functions: {} },
        error: null,
      });
      const { fetchBalanceHistoricalV2Capability, NEGATIVE_CACHE_TTL_MS } = await importFresh();

      await fetchBalanceHistoricalV2Capability();
      vi.advanceTimersByTime(NEGATIVE_CACHE_TTL_MS * 100);
      await fetchBalanceHistoricalV2Capability();

      expect(rpcMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useBalanceHistoricalV2Capability — no mutation fallback", () => {
  it("never calls any RPC other than the read-only capability probe itself", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const { fetchBalanceHistoricalV2Capability } = await importFresh();
    await fetchBalanceHistoricalV2Capability();

    for (const [name] of rpcMock.mock.calls) {
      expect(name).toBe("balance_historical_v2_capabilities_v1");
    }
  });
});
