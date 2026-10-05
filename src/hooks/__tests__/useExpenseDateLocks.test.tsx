/**
 * useExpenseDateLocks -- loading/error/retry behavior (2026-10-01 fail-closed
 * review fix). The hook must fail CLOSED: callers gate date
 * selection/submission on `loading`/`error` rather than guessing, and a
 * `reload()` triggered while a fetch is already in flight must never let a
 * stale (older) response clobber a newer one.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useExpenseDateLocks } from "../useExpenseDateLocks";
import { useAuth } from "@/contexts/AuthContext";
import { fetchExpenseDateLocksResult, type ExpenseDateLocksFetchResult } from "@/lib/expenseDateLocks";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/lib/expenseDateLocks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/expenseDateLocks")>("@/lib/expenseDateLocks");
  return { ...actual, fetchExpenseDateLocksResult: vi.fn() };
});

const mockedFetch = vi.mocked(fetchExpenseDateLocksResult);

function mockAuth(over: Partial<{ organizationId: string | null; enabled: boolean }> = {}) {
  const { organizationId = "org-1", enabled = true } = over;
  vi.mocked(useAuth).mockReturnValue({
    organizationId,
    hasOrganizationFeature: () => enabled,
  } as unknown as ReturnType<typeof useAuth>);
}

/** A controllable promise so a test can resolve fetches in a chosen order. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useExpenseDateLocks -- feature OFF (no behavior change regression guard)", () => {
  it("never fetches, and returns empty locks / loading false / error null", async () => {
    mockAuth({ enabled: false });
    const { result } = renderHook(() => useExpenseDateLocks());
    await new Promise((r) => setTimeout(r, 10));
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ locks: [], loading: false, error: null, enabled: false });
  });
});

describe("useExpenseDateLocks -- loading and error", () => {
  it("is loading immediately when the feature is on, then resolves with locks and no error", async () => {
    mockAuth({ enabled: true });
    const d = deferred<ExpenseDateLocksFetchResult>();
    mockedFetch.mockReturnValue(d.promise);

    const { result } = renderHook(() => useExpenseDateLocks());
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();

    act(() => d.resolve({ ok: true, locks: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("surfaces a non-null error when the fetch fails, distinct from 'loaded, zero locks'", async () => {
    mockAuth({ enabled: true });
    mockedFetch.mockResolvedValue({ ok: false, locks: [], error: "relation does not exist" });

    const { result } = renderHook(() => useExpenseDateLocks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("relation does not exist");
  });
});

describe("useExpenseDateLocks -- reload()", () => {
  it("re-runs the fetch and clears a previous error on success", async () => {
    mockAuth({ enabled: true });
    mockedFetch.mockResolvedValueOnce({ ok: false, locks: [], error: "boom" });
    const { result } = renderHook(() => useExpenseDateLocks());
    await waitFor(() => expect(result.current.error).toBe("boom"));

    mockedFetch.mockResolvedValueOnce({ ok: true, locks: [] });
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("a stale in-flight fetch can never clobber a newer reload's result (request-id race guard)", async () => {
    mockAuth({ enabled: true });
    const first = deferred<ExpenseDateLocksFetchResult>();
    const second = deferred<ExpenseDateLocksFetchResult>();
    mockedFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useExpenseDateLocks());
    expect(result.current.loading).toBe(true);

    // Fire a reload while the initial mount fetch is still in flight --
    // this is the second, newer request.
    act(() => result.current.reload());
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    // The OLDER (first) request resolves LAST in wall-clock terms but
    // reflects stale data -- it must be ignored entirely.
    act(() => second.resolve({ ok: true, locks: [] }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();

    act(() => first.resolve({ ok: false, locks: [], error: "stale failure" }));
    // Give the ignored microtask a chance to (wrongly) apply, if it were going to.
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
