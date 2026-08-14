import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useViewportMode } from "../useViewportMode";

function mockMatchMedia(matches: boolean) {
  const listeners: Array<() => void> = [];
  const mql = {
    matches,
    media: "(max-width: 767px)",
    addEventListener: vi.fn((_: string, cb: () => void) => listeners.push(cb)),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return { mql, triggerChange: (newMatches: boolean) => {
    mql.matches = newMatches;
    listeners.forEach((cb) => cb());
  }};
}

describe("useViewportMode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns isMobile=false when viewport is wider than 767px", () => {
    mockMatchMedia(false);
    const { result } = renderHook(() => useViewportMode());
    expect(result.current.isMobile).toBe(false);
  });

  it("returns isMobile=true when viewport is 767px or narrower", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useViewportMode());
    expect(result.current.isMobile).toBe(true);
  });

  it("updates when media query changes", () => {
    const { triggerChange } = mockMatchMedia(false);
    const { result } = renderHook(() => useViewportMode());
    expect(result.current.isMobile).toBe(false);

    act(() => { triggerChange(true); });
    expect(result.current.isMobile).toBe(true);

    act(() => { triggerChange(false); });
    expect(result.current.isMobile).toBe(false);
  });
});
