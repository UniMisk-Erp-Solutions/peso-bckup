import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useExpensePreview } from "@/hooks/useExpensePreview";

const expenseA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const expenseB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("useExpensePreview", () => {
  it("closes A's preview and clears its url on the same render that selects B", () => {
    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpensePreview(expenseId),
      { initialProps: { expenseId: expenseA as string | null } },
    );
    act(() => {
      result.current.show("https://files.example/a/receipt-1", "image/jpeg", "uploader-a");
    });
    expect(result.current.open).toBe(true);
    expect(result.current.url).toBe("https://files.example/a/receipt-1");

    rerender({ expenseId: expenseB });
    expect(result.current.open).toBe(false);
    expect(result.current.url).toBeNull();
    expect(result.current.contentType).toBeNull();
    expect(result.current.uploadedBy).toBeNull();
  });

  it("still switches preview urls inside the same expense", () => {
    const { result } = renderHook(() => useExpensePreview(expenseA));
    act(() => {
      result.current.show("https://files.example/a/1", "image/jpeg", null);
    });
    act(() => {
      result.current.show("https://files.example/a/2", "image/png", null);
    });
    expect(result.current.open).toBe(true);
    expect(result.current.url).toBe("https://files.example/a/2");
    expect(result.current.contentType).toBe("image/png");

    act(() => {
      result.current.setOpen(false);
    });
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.show("https://files.example/a/3", "image/webp", null);
    });
    expect(result.current.open).toBe(true);
    expect(result.current.url).toBe("https://files.example/a/3");
  });

  it("does not restore A's preview after the review closes", () => {
    const { result, rerender } = renderHook(
      ({ expenseId }: { expenseId: string | null }) => useExpensePreview(expenseId),
      { initialProps: { expenseId: expenseA as string | null } },
    );
    act(() => {
      result.current.show("https://files.example/a/1", "image/jpeg", null);
    });
    rerender({ expenseId: null });
    expect(result.current.open).toBe(false);
    expect(result.current.url).toBeNull();
  });
});
