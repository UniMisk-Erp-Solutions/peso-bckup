/**
 * DEBUG PROTOTYPE (debug/category-server-search-pagination) — Phase 7/8/28
 * acceptance tests for on-demand parent-option configuration loading.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOptionConfiguration } from "../useOptionConfiguration";
import type { OptionConfiguration } from "../categoryServerSearchV2";

const getConfigMock = vi.fn();

vi.mock("../categoryServerSearchV2", () => ({
  getFormTemplateParentOptionConfiguration: (...args: unknown[]) => getConfigMock(...args),
}));

function makeConfig(overrides: Partial<OptionConfiguration> = {}): OptionConfiguration {
  return {
    parentOptionValue: "OPT-1",
    drafts: [],
    configurationFingerprint: "fp-1",
    ...overrides,
  };
}

beforeEach(() => {
  getConfigMock.mockReset();
  getConfigMock.mockResolvedValue(makeConfig());
});

describe("useOptionConfiguration — Phase 7: zero fetch until an option is selected", () => {
  it("stays idle with no backend call on mount", () => {
    renderHook(() => useOptionConfiguration("org-1", "tmpl-1"));
    expect(getConfigMock).not.toHaveBeenCalled();
  });
});

describe("useOptionConfiguration — Phase 8: selecting fetches exactly that option", () => {
  it("selectOption('M447') fetches only M447's configuration", async () => {
    const { result } = renderHook(() => useOptionConfiguration("org-1", "tmpl-1"));
    act(() => {
      result.current.selectOption("M447");
    });
    expect(result.current.loadState).toBe("loading");
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    expect(getConfigMock).toHaveBeenCalledTimes(1);
    expect(getConfigMock).toHaveBeenCalledWith("org-1", "tmpl-1", "M447");
  });

  it("caches an already-loaded option — selecting it again does not re-fetch", async () => {
    const { result } = renderHook(() => useOptionConfiguration("org-1", "tmpl-1"));
    act(() => {
      result.current.selectOption("M447");
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));

    act(() => {
      result.current.selectOption("M448");
    });
    await waitFor(() => expect(getConfigMock).toHaveBeenCalledTimes(2));

    act(() => {
      result.current.selectOption("M447");
    });
    // Cache hit is synchronous — no new network call, state flips straight to success.
    expect(result.current.loadState).toBe("success");
    expect(getConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe("useOptionConfiguration — Phase 28: load failure blocks, no synthesized empty state", () => {
  it("surfaces an error state and keeps drafts empty rather than pretending success", async () => {
    getConfigMock.mockRejectedValueOnce(new Error("timeout"));
    const { result } = renderHook(() => useOptionConfiguration("org-1", "tmpl-1"));
    act(() => {
      result.current.selectOption("M447");
    });
    await waitFor(() => expect(result.current.loadState).toBe("error"));
    expect(result.current.error).toMatch(/timeout/i);
    expect(result.current.drafts).toEqual([]);
  });

  it("retry() re-issues the fetch for the same option, bypassing cache", async () => {
    getConfigMock.mockRejectedValueOnce(new Error("timeout"));
    const { result } = renderHook(() => useOptionConfiguration("org-1", "tmpl-1"));
    act(() => {
      result.current.selectOption("M447");
    });
    await waitFor(() => expect(result.current.loadState).toBe("error"));

    getConfigMock.mockResolvedValueOnce(makeConfig({ parentOptionValue: "M447", configurationFingerprint: "fp-recovered" }));
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    expect(result.current.fingerprint).toBe("fp-recovered");
    expect(getConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe("useOptionConfiguration — race safety", () => {
  it("selecting a second option before the first resolves discards the first's stale result", async () => {
    let resolveFirst!: (v: OptionConfiguration) => void;
    const pendingFirst = new Promise<OptionConfiguration>((r) => (resolveFirst = r));
    getConfigMock.mockImplementationOnce(() => pendingFirst);
    getConfigMock.mockResolvedValueOnce(makeConfig({ parentOptionValue: "M448", configurationFingerprint: "fp-448" }));

    const { result } = renderHook(() => useOptionConfiguration("org-1", "tmpl-1"));
    act(() => {
      result.current.selectOption("M447");
    });
    act(() => {
      result.current.selectOption("M448");
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));
    expect(result.current.fingerprint).toBe("fp-448");

    await act(async () => {
      resolveFirst(makeConfig({ parentOptionValue: "M447", configurationFingerprint: "fp-447-stale" }));
    });
    // The stale M447 response must not overwrite the already-applied M448 state.
    expect(result.current.fingerprint).toBe("fp-448");
    expect(result.current.selectedOption).toBe("M448");
  });
});

describe("useOptionConfiguration — clearSelection", () => {
  it("returns to idle with no drafts/fingerprint", async () => {
    const { result } = renderHook(() => useOptionConfiguration("org-1", "tmpl-1"));
    act(() => {
      result.current.selectOption("M447");
    });
    await waitFor(() => expect(result.current.loadState).toBe("success"));

    act(() => {
      result.current.clearSelection();
    });
    expect(result.current.selectedOption).toBeNull();
    expect(result.current.loadState).toBe("idle");
    expect(result.current.drafts).toEqual([]);
    expect(result.current.fingerprint).toBeNull();
  });
});
