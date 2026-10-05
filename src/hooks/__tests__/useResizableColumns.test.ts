/**
 * Expense table responsive-density hotfix: useResizableColumns must keep
 * manual column resizing fully working while preventing an old, oversized
 * persisted width (saved under much larger pre-hotfix defaults, or an
 * unusually wide manual drag) from permanently forcing horizontal scroll
 * for that one browser -- see the comment above RESTORED_WIDTH_MAX_MULTIPLIER
 * in useResizableColumns.ts for the full rationale.
 */
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useResizableColumns } from "../useResizableColumns";

const STORAGE_KEY = "pw_test_resizable_cols";
const DEFAULTS = { txn: 64, employee: 160, title: 120 };

beforeEach(() => {
  localStorage.clear();
});

describe("useResizableColumns — restored-width clamping", () => {
  it("uses the provided defaults when nothing is persisted", () => {
    const { result } = renderHook(() => useResizableColumns(STORAGE_KEY, DEFAULTS));
    expect(result.current.colWidth("txn")).toBe(64);
    expect(result.current.colWidth("employee")).toBe(160);
    expect(result.current.colWidth("title")).toBe(120);
  });

  it("restores a persisted width that is a reasonable customization unchanged", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ employee: 240 }));
    const { result } = renderHook(() => useResizableColumns(STORAGE_KEY, DEFAULTS));
    expect(result.current.colWidth("employee")).toBe(240);
  });

  it("clamps a persisted width far exceeding the current default rather than discarding it", () => {
    // 3000px is what an old, much-larger pre-hotfix default plus a real drag
    // could plausibly leave behind -- large enough to force scroll on its own
    // at any normal desktop width.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ employee: 3000 }));
    const { result } = renderHook(() => useResizableColumns(STORAGE_KEY, DEFAULTS));
    expect(result.current.colWidth("employee")).toBeLessThan(3000);
    expect(result.current.colWidth("employee")).toBe(160 * 3);
  });

  it("clamps every persisted column independently, keyed to that column's own default", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ txn: 5000, employee: 5000, title: 5000 }),
    );
    const { result } = renderHook(() => useResizableColumns(STORAGE_KEY, DEFAULTS));
    expect(result.current.colWidth("txn")).toBe(64 * 3);
    expect(result.current.colWidth("employee")).toBe(160 * 3);
    expect(result.current.colWidth("title")).toBe(120 * 3);
  });

  it("ignores a corrupt persisted value for one column without discarding the others", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ txn: "not-a-number", employee: 200 }),
    );
    const { result } = renderHook(() => useResizableColumns(STORAGE_KEY, DEFAULTS));
    expect(result.current.colWidth("txn")).toBe(64);
    expect(result.current.colWidth("employee")).toBe(200);
  });

  it("does not clamp an in-progress manual drag -- only restored/persisted values are clamped", () => {
    const { result } = renderHook(() => useResizableColumns(STORAGE_KEY, DEFAULTS));
    const fakeEvent = { preventDefault: vi.fn(), clientX: 0 } as unknown as ReactMouseEvent;

    act(() => {
      result.current.startResize("employee", fakeEvent);
    });

    // Drag far past the 3x-default clamp that would apply on restore.
    // Final width = startWidth (160, the default) + delta (clientX - startX).
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 900 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    // An active drag is intentional (task's own rule: manual overflow is
    // acceptable) -- it must land exactly where the user dragged it, not be
    // silently capped to the 3x restore-time ceiling.
    expect(result.current.colWidth("employee")).toBe(160 + 900);
    expect(result.current.colWidth("employee")).toBeGreaterThan(160 * 3);
  });
});
