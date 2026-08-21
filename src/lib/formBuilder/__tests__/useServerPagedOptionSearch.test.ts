/**
 * DEBUG PROTOTYPE (debug/category-server-search-pagination) — Phase 25/26
 * acceptance tests (SEARCH-1..5, pagination math) for the search state
 * machine, run in isolation against a mocked RPC layer.
 *
 * DOC-100 UI-parity update: search is now a DEBOUNCED auto-search (typing
 * fires one request ~300ms after the last keystroke, matching main's live
 * filter feel while staying request-bounded) instead of requiring an
 * explicit Search button — see useServerPagedOptionSearch.ts's own doc
 * comment. Tests below exercise that debounce with real timers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useServerPagedOptionSearch } from "../useServerPagedOptionSearch";
import type { SearchPage } from "../categoryServerSearchV2";

const searchMock = vi.fn();

vi.mock("../categoryServerSearchV2", () => ({
  searchFormTemplateParentOptions: (...args: unknown[]) => searchMock(...args),
}));

function makePage(overrides: Partial<SearchPage> = {}): SearchPage {
  return {
    results: [],
    page: 1,
    pageSize: 25,
    totalResults: 0,
    totalPages: 1,
    hasPrevious: false,
    hasNext: false,
    ...overrides,
  };
}

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue(makePage());
});

describe("useServerPagedOptionSearch — SEARCH-1: typing debounces to one search", () => {
  it("rapid typing produces exactly one backend call, ~300ms after the last keystroke", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    // DOC-097 hotfix pt.3 Part 1: the hook auto-loads page 1 on mount --
    // let that settle and clear the spy before exercising typing behavior.
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    act(() => {
      result.current.setSearchInput("2");
      result.current.setSearchInput("20");
      result.current.setSearchInput("202");
      result.current.setSearchInput("2026");
      result.current.setSearchInput("202608");
      result.current.setSearchInput("202608M447");
    });
    // No request yet — still within the debounce window.
    expect(searchMock).not.toHaveBeenCalled();

    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", "202608M447", 1, 25, false);
  });
});

describe("useServerPagedOptionSearch — SEARCH-2: Enter submits immediately, bypassing the debounce", () => {
  it("runSearch() called right after typing produces exactly one backend call", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    act(() => {
      result.current.setSearchInput("query");
    });
    act(() => {
      result.current.runSearch();
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    // Only the immediate runSearch() call — no separate debounced call fires
    // afterward for the same unchanged input.
    await new Promise((r) => setTimeout(r, 350));
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", "query", 1, 25, false);
  });
});

describe("useServerPagedOptionSearch — SEARCH-3: page navigation uses submittedSearch, not unsent input", () => {
  it("Next Page after typing a new (unsent) query still uses the last SUBMITTED query", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    act(() => {
      result.current.setSearchInput("queryA");
    });
    act(() => {
      result.current.runSearch();
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    expect(searchMock).toHaveBeenLastCalledWith("org-1", "tmpl-1", "queryA", 1, 25, false);
    searchMock.mockClear();

    // User types a different query but does NOT press Search — goToPage
    // fires before the debounce for "queryB" has a chance to elapse.
    act(() => {
      result.current.setSearchInput("queryB");
    });
    act(() => {
      result.current.goToPage(2);
    });
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", "queryA", 2, 25, false));
  });
});

describe("useServerPagedOptionSearch — SEARCH-4: stale-response race safety", () => {
  it("an earlier search resolving after a later one does not overwrite the later results", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    let resolveA!: (v: SearchPage) => void;
    let resolveB!: (v: SearchPage) => void;
    const pendingA = new Promise<SearchPage>((r) => (resolveA = r));
    const pendingB = new Promise<SearchPage>((r) => (resolveB = r));
    searchMock.mockImplementationOnce(() => pendingA).mockImplementationOnce(() => pendingB);

    act(() => {
      result.current.setSearchInput("A");
    });
    act(() => {
      result.current.runSearch();
    });
    act(() => {
      result.current.setSearchInput("B");
    });
    act(() => {
      result.current.runSearch();
    });

    // B resolves first (as if it raced ahead of A on the network).
    await act(async () => {
      resolveB(makePage({ totalResults: 999 }));
    });
    await waitFor(() => expect(result.current.page?.totalResults).toBe(999));

    // A resolves after — must NOT overwrite B's results.
    await act(async () => {
      resolveA(makePage({ totalResults: 1 }));
    });
    expect(result.current.page?.totalResults).toBe(999);
  });
});

describe("useServerPagedOptionSearch — SEARCH-5: blank query + Search returns the browse page", () => {
  it("submits null query (server treats as browse-all) when the input is blank", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    act(() => {
      result.current.runSearch();
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", null, 1, 25, false);
  });

  it("trims whitespace-only input down to a null query too", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    act(() => {
      result.current.setSearchInput("   ");
    });
    act(() => {
      result.current.runSearch();
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", null, 1, 25, false);
  });
});

describe("useServerPagedOptionSearch — configured-only filter", () => {
  it("toggling configuredOnly re-fetches page 1 with the flag set, using the current query/page size", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    act(() => {
      result.current.setConfiguredOnly(true);
    });
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", null, 1, 25, true));
    expect(result.current.configuredOnly).toBe(true);
  });
});

describe("useServerPagedOptionSearch — pagination", () => {
  it("changing page size resets to page 1 and re-fetches once", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    act(() => {
      result.current.runSearch();
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    act(() => {
      result.current.setPageSize(50);
    });
    await waitFor(() => expect(searchMock).toHaveBeenCalledTimes(1));
    expect(searchMock).toHaveBeenCalledWith("org-1", "tmpl-1", null, 1, 50, false);
  });

  it("501 results at 25/page reports 21 total pages and correct has_next/has_previous at the edges", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    searchMock.mockResolvedValueOnce(
      makePage({ page: 1, pageSize: 25, totalResults: 501, totalPages: 21, hasPrevious: false, hasNext: true }),
    );
    act(() => {
      result.current.runSearch();
    });
    await waitFor(() => expect(result.current.page?.totalPages).toBe(21));
    expect(result.current.page?.hasPrevious).toBe(false);
    expect(result.current.page?.hasNext).toBe(true);

    searchMock.mockResolvedValueOnce(
      makePage({ page: 21, pageSize: 25, totalResults: 501, totalPages: 21, hasPrevious: true, hasNext: false }),
    );
    act(() => {
      result.current.goToPage(21);
    });
    await waitFor(() => expect(result.current.page?.page).toBe(21));
    expect(result.current.page?.hasNext).toBe(false);
    expect(result.current.page?.hasPrevious).toBe(true);
  });
});

describe("useServerPagedOptionSearch — error + retry", () => {
  it("surfaces a load error and retry() re-issues the same query/page", async () => {
    const { result } = renderHook(() => useServerPagedOptionSearch("org-1", "tmpl-1"));
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    searchMock.mockClear();

    searchMock.mockRejectedValueOnce(new Error("network down"));
    act(() => {
      result.current.setSearchInput("q");
    });
    act(() => {
      result.current.runSearch();
    });
    await waitFor(() => expect(result.current.loadState).toBe("error"));
    expect(result.current.error).toMatch(/network down/i);

    searchMock.mockResolvedValueOnce(makePage({ totalResults: 3 }));
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    expect(result.current.page?.totalResults).toBe(3);
  });
});
