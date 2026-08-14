/**
 * Keyset cursor cache (DOC-080 §11).
 *
 * Keyset paging has no random access: page N is normally only reachable by
 * walking there. This hook remembers the cursor that STARTS each page it has
 * seen, so Previous and revisits are free, and an explicit jump only pays for
 * the anchor RPC once.
 *
 * `queryShapeKey` is the safety interlock. A cursor from a different filter set
 * points into a different result sequence, so when the shape changes the whole
 * map is dropped and the logical page resets to 1 — keeping it would silently
 * return the wrong slice.
 */

import { useCallback, useRef, useState } from "react";
import type { ReviewQueueCursor } from "../types";

export type CursorMap = Map<number, ReviewQueueCursor | null>;

export function useCursorHistory(queryShapeKey: string) {
  const [pageNumber, setPageNumber] = useState(1);
  const [cursor, setCursor] = useState<ReviewQueueCursor | null>(null);
  // Page 1 always starts at the beginning.
  const cache = useRef<CursorMap>(new Map([[1, null]]));
  const [visitedPages, setVisitedPages] = useState<number[]>([1]);
  const shapeRef = useRef(queryShapeKey);

  const reset = useCallback(() => {
    cache.current = new Map([[1, null]]);
    setVisitedPages([1]);
    setPageNumber(1);
    setCursor(null);
  }, []);

  /**
   * Any change to what is being queried invalidates every cached cursor, and it
   * must take effect DURING this render, not in an effect afterwards.
   *
   * This was a real defect, not a style preference. With the reset in a
   * `useEffect`, the render that first carried a newly selected employee still
   * carried the previous query's cursor. The queue key was built from that pair,
   * so a request went out asking for "employee 6174's rows after a cursor from
   * position ~4,000 of the unfiltered 7,699-row ordering" — a predicate no row
   * in a 24-row sequence can satisfy. The table showed "No assigned expenses",
   * and the empty result was then cached under that key.
   *
   * Adjusting state during render is React's documented pattern for exactly
   * this: derived state that must not lag its input by a commit.
   */
  if (shapeRef.current !== queryShapeKey) {
    shapeRef.current = queryShapeKey;
    cache.current = new Map([[1, null]]);
    // Safe during render: same-component setState, and every call is a no-op
    // once the values already match, so this cannot loop.
    setVisitedPages([1]);
    setPageNumber(1);
    setCursor(null);
  }

  const remember = useCallback((page: number, c: ReviewQueueCursor | null) => {
    cache.current.set(page, c);
    setVisitedPages((prev) => (prev.includes(page) ? prev : [...prev, page].sort((a, b) => a - b)));
  }, []);

  /** Advance using the cursor the server just handed back. */
  const goNext = useCallback(
    (nextCursor: ReviewQueueCursor | null) => {
      // No cursor means the server said there is no next page.
      if (!nextCursor) return;
      const target = pageNumber + 1;
      remember(target, nextCursor);
      setCursor(nextCursor);
      setPageNumber(target);
    },
    [pageNumber, remember],
  );

  const goPrevious = useCallback(() => {
    if (pageNumber <= 1) return;
    const target = pageNumber - 1;
    setCursor(cache.current.get(target) ?? null);
    setPageNumber(target);
  }, [pageNumber]);

  /** True when the page can be reached without an anchor request. */
  const hasCursorFor = useCallback(
    (page: number) => page === 1 || cache.current.has(page),
    [],
  );

  /** Jump to a page whose cursor is already known. Returns false if it is not. */
  const goToCachedPage = useCallback(
    (page: number) => {
      if (page < 1) return false;
      if (page !== 1 && !cache.current.has(page)) return false;
      setCursor(cache.current.get(page) ?? null);
      setPageNumber(page);
      return true;
    },
    [],
  );

  /** Land on a page using a cursor resolved by the anchor RPC. */
  const goToAnchoredPage = useCallback(
    (page: number, anchorCursor: ReviewQueueCursor | null) => {
      remember(page, anchorCursor);
      setCursor(anchorCursor);
      setPageNumber(page);
    },
    [remember],
  );

  return {
    cursor,
    pageNumber,
    visitedPages,
    canGoPrevious: pageNumber > 1,
    goNext,
    goPrevious,
    goToCachedPage,
    goToAnchoredPage,
    hasCursorFor,
    reset,
  };
}
