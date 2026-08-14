import { describe, it, expect } from "vitest";
import {
  getTotalPages,
  clampPage,
  paginateItems,
  getPaginationRange,
  getVisiblePageNumbers,
} from "@/lib/listPagination";

describe("getTotalPages", () => {
  it("18. 105 items at pageSize 25 → 5 pages", () => {
    expect(getTotalPages(105, 25)).toBe(5);
  });

  it("exact multiple → correct count", () => {
    expect(getTotalPages(100, 25)).toBe(4);
  });

  it("zero items → 1 page", () => {
    expect(getTotalPages(0, 25)).toBe(1);
  });

  it("zero pageSize → 1 page (no divide-by-zero)", () => {
    expect(getTotalPages(100, 0)).toBe(1);
  });

  it("1 item → 1 page", () => {
    expect(getTotalPages(1, 25)).toBe(1);
  });
});

describe("clampPage", () => {
  it("clamps over-range page to last page", () => {
    expect(clampPage(10, 105, 25)).toBe(5);
  });

  it("clamps page 0 to page 1", () => {
    expect(clampPage(0, 100, 25)).toBe(1);
  });

  it("valid page unchanged", () => {
    expect(clampPage(3, 105, 25)).toBe(3);
  });

  it("page negative → 1", () => {
    expect(clampPage(-5, 100, 25)).toBe(1);
  });

  it("26. last user removed on last page — clamps safely", () => {
    // 50 items, pageSize 25 → 2 pages; remove last item (49 items) → still 2 pages
    expect(clampPage(2, 49, 25)).toBe(2);
    // remove one more (48 items) → still 2 pages
    expect(clampPage(2, 48, 25)).toBe(2);
    // remove until page 2 would be empty (25 items) → clamp to page 1
    expect(clampPage(2, 25, 25)).toBe(1);
  });
});

describe("paginateItems", () => {
  const items = Array.from({ length: 30 }, (_, i) => i + 1); // [1..30]

  it("19. page 1 of 25 returns first 25 items", () => {
    expect(paginateItems(items, 1, 25)).toEqual(items.slice(0, 25));
  });

  it("20. page 5 of 105 at size 25 returns last 5 items", () => {
    const big = Array.from({ length: 105 }, (_, i) => i + 1);
    const page5 = paginateItems(big, 5, 25);
    expect(page5).toHaveLength(5);
    expect(page5[0]).toBe(101);
  });

  it("page 2 of 30 at size 25 → 5 items", () => {
    expect(paginateItems(items, 2, 25)).toHaveLength(5);
  });

  it("zero pageSize returns full array", () => {
    expect(paginateItems(items, 1, 0)).toHaveLength(30);
  });
});

describe("getPaginationRange", () => {
  it("empty list → from=0, to=0, total=0", () => {
    expect(getPaginationRange(1, 25, 0)).toEqual({ from: 0, to: 0, total: 0 });
  });

  it("page 1 of 105 at size 25 → from=1, to=25", () => {
    expect(getPaginationRange(1, 25, 105)).toEqual({ from: 1, to: 25, total: 105 });
  });

  it("page 5 of 105 at size 25 → from=101, to=105", () => {
    expect(getPaginationRange(5, 25, 105)).toEqual({ from: 101, to: 105, total: 105 });
  });

  it("page 2 of 30 at size 25 → from=26, to=30", () => {
    expect(getPaginationRange(2, 25, 30)).toEqual({ from: 26, to: 30, total: 30 });
  });
});

describe("getVisiblePageNumbers", () => {
  it("few pages — all shown", () => {
    expect(getVisiblePageNumbers(1, 5, 7)).toEqual([1, 2, 3, 4, 5]);
  });

  it("many pages — includes first, ellipsis, last", () => {
    const pages = getVisiblePageNumbers(6, 20, 7);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(20);
    expect(pages).toContain(-1); // ellipsis present
  });

  it("page near start — leading ellipsis absent", () => {
    const pages = getVisiblePageNumbers(2, 20, 7);
    // Should show [1, 2, 3, 4, 5, -1, 20] or similar, first two not ellipsis
    expect(pages[0]).toBe(1);
    expect(pages[1]).not.toBe(-1);
  });

  it("page near end — trailing ellipsis absent", () => {
    const pages = getVisiblePageNumbers(19, 20, 7);
    expect(pages[pages.length - 1]).toBe(20);
    expect(pages[pages.length - 2]).not.toBe(-1);
  });
});
