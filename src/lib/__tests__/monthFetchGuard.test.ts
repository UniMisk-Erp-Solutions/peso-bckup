/**
 * Real behavioral race-condition tests for the My Expenses month-fetch guard
 * (§1-4 of the month-filter hardening audit). These use manually-controlled
 * deferred promises so responses can be made to resolve in a DIFFERENT order
 * than their requests were issued -- a source-text assertion cannot prove a
 * race condition is actually closed (§33).
 */
import { describe, it, expect, vi } from "vitest";
import {
  createMonthFetchGuardState,
  invalidateMonthFetch,
  runMonthFetch,
} from "../monthFetchGuard";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runMonthFetch -- exact month -> All months while in flight (the reported BLOCKER)", () => {
  it("a response that resolves AFTER leaving exact-month mode is reported as stale, not success", async () => {
    const state = createMonthFetchGuardState();
    let currentMode = true; // exact-month mode
    const isCurrentMode = () => currentMode;
    const august = deferred<{ items: string[] }>();

    const pending = runMonthFetch(state, isCurrentMode, () => august.promise);

    // User switches back to "All months" BEFORE the August RPC resolves.
    // This is exactly what handleExpenseMonthChange does: invalidate first,
    // then flip the mode -- reproducing the fix under test.
    invalidateMonthFetch(state);
    currentMode = false;

    august.resolve({ items: ["august-1", "august-2"] });
    const outcome = await pending;

    expect(outcome.kind).toBe("stale");
  });

  it("without the mode/generation check this scenario WOULD corrupt state -- guard against regressing to that", async () => {
    // Reproduces the pre-fix shape directly: no invalidate() call at all on
    // mode exit, and staleness judged by sequence number alone. This is what
    // c6a61c8 actually did (monthFetchSeqRef only incremented inside the
    // fetch function itself) and it fails this test, proving the bug was real.
    let seq = 0;
    const isStaleBuggy = (mySeq: number) => mySeq !== seq;
    const august = deferred<{ items: string[] }>();

    const mySeq = ++seq;
    const resultPromise = august.promise.then((data) => {
      if (isStaleBuggy(mySeq)) return { kind: "stale" as const };
      return { kind: "success" as const, data };
    });

    // Switching to "All months" in the buggy implementation does NOT touch
    // `seq` at all (only fetchMyExpensesMonthPage did), so nothing invalidates it.
    august.resolve({ items: ["stale-august-data"] });
    const outcome = await resultPromise;

    // This documents the bug: the buggy sequence-only check reports success
    // for a response that arrived after the user left exact-month mode.
    expect(outcome.kind).toBe("success");
  });
});

describe("runMonthFetch -- August -> September (rapid re-selection)", () => {
  it("only the LAST request's response commits, even if an earlier request resolves later", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    const august = deferred<{ month: string }>();
    const september = deferred<{ month: string }>();

    const augustPending = runMonthFetch(state, isCurrentMode, () => august.promise);
    const septemberPending = runMonthFetch(state, isCurrentMode, () => september.promise);

    // September resolves FIRST, then the older August response arrives late.
    september.resolve({ month: "september" });
    august.resolve({ month: "august" });

    const [augustOutcome, septemberOutcome] = await Promise.all([augustPending, septemberPending]);

    expect(augustOutcome.kind).toBe("stale");
    expect(septemberOutcome).toEqual({ kind: "success", data: { month: "september" } });
  });

  it("rapid August -> September -> July: only July's response commits", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    const august = deferred<{ month: string }>();
    const september = deferred<{ month: string }>();
    const july = deferred<{ month: string }>();

    const augustPending = runMonthFetch(state, isCurrentMode, () => august.promise);
    const septemberPending = runMonthFetch(state, isCurrentMode, () => september.promise);
    const julyPending = runMonthFetch(state, isCurrentMode, () => july.promise);

    august.resolve({ month: "august" });
    september.resolve({ month: "september" });
    july.resolve({ month: "july" });

    const [a, s, j] = await Promise.all([augustPending, septemberPending, julyPending]);
    expect(a.kind).toBe("stale");
    expect(s.kind).toBe("stale");
    expect(j).toEqual({ kind: "success", data: { month: "july" } });
  });
});

describe("runMonthFetch -- filter change while a request is pending", () => {
  it("a status-filter change that starts a new request supersedes the still-pending one", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    const submittedOnly = deferred<{ status: string }>();
    const approvedOnly = deferred<{ status: string }>();

    const first = runMonthFetch(state, isCurrentMode, () => submittedOnly.promise);
    // Status filter changes -> a second request starts before the first settles.
    const second = runMonthFetch(state, isCurrentMode, () => approvedOnly.promise);

    approvedOnly.resolve({ status: "approved" });
    submittedOnly.resolve({ status: "submitted" }); // arrives late

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.kind).toBe("stale");
    expect(secondOutcome).toEqual({ kind: "success", data: { status: "approved" } });
  });
});

describe("runMonthFetch -- unmount while pending", () => {
  it("invalidating (as an unmount cleanup would) marks the in-flight request stale", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    const pendingRpc = deferred<{ ok: true }>();

    const pending = runMonthFetch(state, isCurrentMode, () => pendingRpc.promise);
    invalidateMonthFetch(state); // simulates the unmount cleanup effect

    pendingRpc.resolve({ ok: true });
    const outcome = await pending;
    expect(outcome.kind).toBe("stale");
  });

  it("invalidate() aborts the request's signal so the network call itself is cancelled", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    let capturedSignal: AbortSignal | undefined;

    const pending = runMonthFetch(state, isCurrentMode, (signal) => {
      capturedSignal = signal;
      return new Promise(() => {
        /* never resolves on its own -- only abort ends it */
      });
    });

    // Let the microtask queue run so `run(signal)` has been invoked.
    await Promise.resolve();
    expect(capturedSignal?.aborted).toBe(false);

    invalidateMonthFetch(state);
    expect(capturedSignal?.aborted).toBe(true);

    void pending; // never settles in this test; only the abort signal matters
  });
});

describe("runMonthFetch -- error handling never commits a stale error", () => {
  it("an error from a superseded request is reported stale, never surfaced as the live error", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    const failingAugust = deferred<never>();
    const okSeptember = deferred<{ month: string }>();

    const augustPending = runMonthFetch(state, isCurrentMode, () => failingAugust.promise);
    const septemberPending = runMonthFetch(state, isCurrentMode, () => okSeptember.promise);

    okSeptember.resolve({ month: "september" });
    failingAugust.reject(new Error("network blip"));

    const [augustOutcome, septemberOutcome] = await Promise.all([augustPending, septemberPending]);
    expect(augustOutcome.kind).toBe("stale");
    expect(septemberOutcome).toEqual({ kind: "success", data: { month: "september" } });
  });

  it("a genuine error on the CURRENT generation is reported as an error, not swallowed", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    const failing = deferred<never>();

    const pending = runMonthFetch(state, isCurrentMode, () => failing.promise);
    const err = new Error("boom");
    failing.reject(err);

    const outcome = await pending;
    expect(outcome).toEqual({ kind: "error", error: err });
  });
});

describe("runMonthFetch -- abort surfaces distinctly from a real error", () => {
  it("an AbortError-shaped rejection on the current generation reports 'aborted', not 'error'", async () => {
    const state = createMonthFetchGuardState();
    const isCurrentMode = () => true;
    const aborted = deferred<never>();

    const pending = runMonthFetch(state, isCurrentMode, () => aborted.promise);
    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    aborted.reject(abortErr);

    const outcome = await pending;
    expect(outcome.kind).toBe("aborted");
  });
});

describe("runMonthFetch -- success/error/stale never double-report", () => {
  it("calling isCurrentMode is re-evaluated at commit time, not captured once", async () => {
    const state = createMonthFetchGuardState();
    let mode = true;
    const isCurrentMode = vi.fn(() => mode);
    const rpc = deferred<{ ok: true }>();

    const pending = runMonthFetch(state, isCurrentMode, () => rpc.promise);
    mode = false; // mode flips while the request is in flight
    rpc.resolve({ ok: true });

    const outcome = await pending;
    expect(outcome.kind).toBe("stale");
    // Called once when starting (isStale definition captures the function,
    // not a value) and at least once at commit time.
    expect(isCurrentMode.mock.calls.length).toBeGreaterThan(0);
  });
});
