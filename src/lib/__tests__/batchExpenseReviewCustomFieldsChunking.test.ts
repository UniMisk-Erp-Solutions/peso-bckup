/**
 * Regression tests for the Batch Review custom-field query storm
 * (2026-08-13 Production incident: fetchBatchExpenseCustomFields fired one
 * unchunked `.in("expense_id", ids)` request; a single retrying client
 * generated 1,378 requests / 335 HTTP 500 / 1,043 HTTP 504 in 43 minutes and
 * degraded the shared database for other reviewers too).
 *
 * Covers: dedup, chunking, sequential (never parallel) execution, error
 * surfacing (never silently empty), abort handling, and single-flight
 * dedup of concurrent same-batch callers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchBatchExpenseCustomFields } from "@/lib/batchExpenseReview";

type Call = { table: string; method: "in" | "eq"; args: unknown[] };

let calls: Call[] = [];
let inFlightCount = 0;
let maxConcurrentInFlight = 0;
/** One response per expense_form_field_values `.in()` call, consumed in order. */
let valueResponses: Array<{ data: unknown[] | null; error: { message: string } | null }> = [];
let valueCallIndex = 0;

function emptyChain(data: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (...args: unknown[]) => {
    calls.push({ table: "meta", method: "eq", args });
    return chain;
  };
  chain.in = (...args: unknown[]) => {
    calls.push({ table: "meta", method: "in", args });
    return chain;
  };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(table: string) {
      if (table !== "expense_form_field_values") return emptyChain([]);

      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = (_col: string, ids: string[]) => {
        calls.push({ table, method: "in", args: [ids] });
        return chain;
      };
      chain.eq = (..._args: unknown[]) => chain;
      chain.then = (resolve: (v: unknown) => unknown, reject?: (v: unknown) => unknown) => {
        inFlightCount++;
        maxConcurrentInFlight = Math.max(maxConcurrentInFlight, inFlightCount);
        const response = valueResponses[valueCallIndex] ?? { data: [], error: null };
        valueCallIndex++;
        return new Promise((res) => setTimeout(res, 1))
          .then(() => {
            inFlightCount--;
            return response;
          })
          .then(resolve, reject);
      };
      return chain;
    },
  },
}));

beforeEach(() => {
  calls = [];
  inFlightCount = 0;
  maxConcurrentInFlight = 0;
  valueResponses = [];
  valueCallIndex = 0;
});

function valueFetchCalls(): Call[] {
  return calls.filter((c) => c.table === "expense_form_field_values");
}

describe("fetchBatchExpenseCustomFields — dedup and chunking", () => {
  it("zero ids performs zero requests", async () => {
    const result = await fetchBatchExpenseCustomFields([], "org-1", "batch-1");
    expect(result.status).toBe("ok");
    expect(valueFetchCalls()).toHaveLength(0);
  });

  it("empty/falsy ids are skipped, duplicate ids are deduped into one request", async () => {
    valueResponses = [{ data: [], error: null }];
    const result = await fetchBatchExpenseCustomFields(
      ["e1", "", "e1", "e1", "e2"],
      "org-1",
      "batch-1",
    );
    expect(result.status).toBe("ok");
    expect(valueFetchCalls()).toHaveLength(1);
    expect(valueFetchCalls()[0].args[0]).toEqual(["e1", "e2"]);
  });

  it("1-10 ids fit in a single request (chunk size proven safe via Production EXPLAIN ANALYZE)", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `e${i}`);
    valueResponses = [{ data: [], error: null }];
    await fetchBatchExpenseCustomFields(ids, "org-1", "batch-1");
    expect(valueFetchCalls()).toHaveLength(1);
  });

  it("more than the chunk size splits into multiple bounded requests", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `e${i}`);
    valueResponses = [
      { data: [], error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    await fetchBatchExpenseCustomFields(ids, "org-1", "batch-1");
    const fetches = valueFetchCalls();
    expect(fetches.length).toBeGreaterThan(1);
    for (const call of fetches) {
      expect((call.args[0] as string[]).length).toBeLessThanOrEqual(10);
    }
    // exact request count for a 25-id batch is deterministic given the chunk size
    expect(fetches).toHaveLength(3);
  });

  it("a 100-id batch never fires more requests than ceil(100/chunkSize)", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `e${i}`);
    valueResponses = Array.from({ length: 20 }, () => ({ data: [], error: null }));
    await fetchBatchExpenseCustomFields(ids, "org-1", "batch-1");
    expect(valueFetchCalls().length).toBeLessThanOrEqual(10);
  });

  it("chunks execute sequentially — never more than 1 concurrent expense_form_field_values request", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `e${i}`);
    valueResponses = Array.from({ length: 5 }, () => ({ data: [], error: null }));
    await fetchBatchExpenseCustomFields(ids, "org-1", "batch-1");
    expect(maxConcurrentInFlight).toBe(1);
  });
});

describe("fetchBatchExpenseCustomFields — error handling (never silently empty)", () => {
  it("surfaces a chunk failure as an explicit error, not an empty success", async () => {
    valueResponses = [{ data: null, error: { message: "canceling statement due to statement timeout" } }];
    const result = await fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1");
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("statement timeout");
    }
  });

  it("stops at the first failed chunk instead of continuing to hammer the DB", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `e${i}`);
    valueResponses = [
      { data: [], error: null },
      { data: null, error: { message: "timeout" } },
      { data: [], error: null }, // must never be reached
    ];
    const result = await fetchBatchExpenseCustomFields(ids, "org-1", "batch-1");
    expect(result.status).toBe("error");
    expect(valueFetchCalls()).toHaveLength(2);
  });

  it("does not automatically retry a failed request", async () => {
    valueResponses = [{ data: null, error: { message: "timeout" } }];
    await fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1");
    expect(valueFetchCalls()).toHaveLength(1);
  });
});

describe("fetchBatchExpenseCustomFields — abort and single-flight", () => {
  it("returns aborted status and stops issuing further chunks when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1", controller.signal);
    expect(result.status).toBe("aborted");
    expect(valueFetchCalls()).toHaveLength(0);
  });

  it("concurrent calls for the same organizationId+batchId share one in-flight request (single-flight)", async () => {
    valueResponses = [{ data: [], error: null }];
    const [a, b] = await Promise.all([
      fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1"),
      fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1"),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(valueFetchCalls()).toHaveLength(1);
  });

  it("concurrent calls for a DIFFERENT batchId are not deduped against each other", async () => {
    valueResponses = [{ data: [], error: null }, { data: [], error: null }];
    await Promise.all([
      fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1"),
      fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-2"),
    ]);
    expect(valueFetchCalls()).toHaveLength(2);
  });

  it("a fresh call after the previous in-flight request settles issues a new request (no permanent caching)", async () => {
    valueResponses = [{ data: [], error: null }, { data: [], error: null }];
    await fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1");
    await fetchBatchExpenseCustomFields(["e1"], "org-1", "batch-1");
    expect(valueFetchCalls()).toHaveLength(2);
  });
});
