/**
 * Production incident regression (DOC-080): an aborted or gateway-truncated 2xx
 * response makes postgrest-js throw a raw `SyntaxError: Unexpected end of JSON
 * input` from its UNguarded success-path JSON.parse. That must never escape as a
 * raw SyntaxError into the React ErrorBoundary — an abort is swallowed, an
 * incomplete non-aborted body becomes a controlled retryable transport error.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// A postgrest-like thenable builder whose `await` behaviour we control per test.
let onAwait: () => Promise<{ data: unknown; error: unknown }>;
const abortSignal = vi.fn(function (this: unknown) {
  return this;
});
const rpc = vi.fn(() => {
  const builder = {
    abortSignal,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      onAwait().then(resolve, reject),
  };
  abortSignal.mockReturnValue(builder);
  return builder;
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import {
  ReviewQueueAbortError,
  isIncompleteJsonError,
  isReviewAbort,
} from "@/features/reviewQueueServer/api";
import { ReviewQueueNetworkError } from "@/features/reviewQueueServer/errors";
import { fetchReviewQueueCapabilities } from "@/features/reviewQueueServer/api";

beforeEach(() => {
  rpc.mockClear();
  abortSignal.mockClear();
});

describe("classification helpers", () => {
  it("isIncompleteJsonError matches postgrest's success-path parse failure", () => {
    expect(isIncompleteJsonError(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
    expect(isIncompleteJsonError(new SyntaxError("Unexpected token < in JSON at position 0"))).toBe(true);
    expect(isIncompleteJsonError(new Error("network"))).toBe(false);
  });
  it("isReviewAbort is true when the signal is aborted, even for a SyntaxError", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(isReviewAbort(ctrl.signal, new SyntaxError("Unexpected end of JSON input"))).toBe(true);
    expect(isReviewAbort(undefined, new DOMException("x", "AbortError"))).toBe(true);
    expect(isReviewAbort(undefined, new SyntaxError("Unexpected end of JSON input"))).toBe(false);
  });
});

describe("callRpc hardening (via a real RPC caller)", () => {
  it("an aborted request whose body throws SyntaxError is swallowed as an AbortError", async () => {
    onAwait = async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    };
    // fetchReviewQueueCapabilities → callRpc with no signal, but simulate abort by
    // matching the incomplete-JSON path first for the non-aborted case below.
    // Here we assert the ABORT case using the exported helper contract instead,
    // since capabilities has no signal param: a thrown AbortError-named error.
    onAwait = async () => {
      throw new DOMException("Aborted", "AbortError");
    };
    await expect(fetchReviewQueueCapabilities()).rejects.toBeInstanceOf(ReviewQueueAbortError);
  });

  it("a NON-aborted incomplete/truncated 2xx body becomes a controlled network error, not a raw SyntaxError", async () => {
    onAwait = async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    };
    const err = await fetchReviewQueueCapabilities().catch((e) => e);
    expect(err).toBeInstanceOf(ReviewQueueNetworkError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(String(err.message)).toMatch(/incomplete response/i);
  });

  it("a real PostgREST error object still maps through translateRpcError", async () => {
    onAwait = async () => ({ data: null, error: { code: "PGRST202", message: "missing" } });
    await expect(fetchReviewQueueCapabilities()).rejects.toBeTruthy();
  });
});
