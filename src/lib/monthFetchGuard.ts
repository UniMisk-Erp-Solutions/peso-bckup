/**
 * Generation-token + abort guard for a mode that can be entered, re-entered,
 * or left entirely while a request is in flight (My Expenses' exact-month
 * server paging, §1-4 of the month-filter hardening audit).
 *
 * Extracted out of Expenses.tsx so the actual invalidation logic can be
 * exercised with real deferred-promise tests instead of only being provable
 * by reading source text -- a source-contract test cannot prove a race
 * condition is actually closed.
 */

export type MonthFetchGuardState = {
  seq: number;
  controller: AbortController | null;
};

export function createMonthFetchGuardState(): MonthFetchGuardState {
  return { seq: 0, controller: null };
}

/**
 * Immediately invalidates any in-flight request tracked by this guard and
 * aborts it. Call this the instant the caller changes or leaves the mode a
 * request belongs to -- BEFORE any new request is necessarily started (e.g.
 * leaving exact-month mode entirely starts no new request at all, so this is
 * the only thing that stops a late response from an old month from landing).
 */
export function invalidateMonthFetch(state: MonthFetchGuardState): void {
  state.seq += 1;
  state.controller?.abort();
  state.controller = null;
}

export type MonthFetchOutcome<T> =
  | { kind: "success"; data: T }
  | { kind: "error"; error: unknown }
  // Superseded by a newer generation, or the mode was left entirely --
  // either way this response has zero authority and must be dropped.
  | { kind: "stale" }
  // This exact request was the one aborted (by a newer call or invalidate()).
  | { kind: "aborted" };

function isAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") {
    return true;
  }
  return false;
}

/**
 * Runs one generation-gated, abortable async request.
 *
 * `isCurrentMode()` is checked at commit time in ADDITION to the sequence
 * number -- not merely a stale closure, since it is invoked fresh each time
 * rather than captured once. This is what guarantees an old exact-month
 * response has zero authority once the caller is back in "all" mode, even if
 * some future refactor ever let a sequence number coincidentally repeat.
 */
export async function runMonthFetch<T>(
  state: MonthFetchGuardState,
  isCurrentMode: () => boolean,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<MonthFetchOutcome<T>> {
  state.controller?.abort();
  const seq = ++state.seq;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  state.controller = controller;
  const isStale = () => seq !== state.seq || !isCurrentMode();

  try {
    const data = await run(controller?.signal);
    if (isStale()) return { kind: "stale" };
    return { kind: "success", data };
  } catch (error) {
    if (isStale()) return { kind: "stale" };
    if (isAbort(controller?.signal, error)) return { kind: "aborted" };
    return { kind: "error", error };
  } finally {
    if (state.controller === controller) state.controller = null;
  }
}
