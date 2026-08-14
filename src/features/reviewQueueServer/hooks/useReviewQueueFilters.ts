/**
 * Filter state + pagination reset (DOC-080).
 *
 * Any change to what is being queried resets pagination, because a cursor from
 * the previous filter set points into a different result sequence.
 */

import { useCallback, useMemo, useState } from "react";
import type { ReviewCustomFilter, ReviewQueueSort, ReviewTimePeriod } from "../types";

export const REVIEW_PAGE_SIZES = [10, 25, 50, 100] as const;

export type ReviewQueueFilterState = {
  statuses: string[];
  categories: string[];
  timePeriod: ReviewTimePeriod;
  actionableOnly: boolean;
  customFilters: ReviewCustomFilter[];
  sort: ReviewQueueSort;
  pageSize: number;
};

const INITIAL: ReviewQueueFilterState = {
  statuses: [],
  categories: [],
  timePeriod: "all",
  actionableOnly: false,
  customFilters: [],
  sort: "created_desc",
  pageSize: 25,
};

/** Derives an inclusive date window from the period. `all` means no bounds. */
export function timePeriodToRange(
  period: ReviewTimePeriod,
  now: Date,
): { from: string | null; to: string | null } {
  if (period === "all") return { from: null, to: null };
  const days = period === "week" ? 7 : period === "month" ? 30 : 365;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(now) };
}

/**
 * Filter state only. Pagination lives in useCursorHistory, which resets itself
 * from the query-shape key — that way a filter change cannot leave a cursor
 * pointing into a different result sequence.
 */
export function useReviewQueueFilters(options?: { onQueryShapeChange?: () => void }) {
  const [filters, setFilters] = useState<ReviewQueueFilterState>(INITIAL);
  const onShapeChange = options?.onQueryShapeChange;

  const patch = useCallback(
    (next: Partial<ReviewQueueFilterState>) => {
      setFilters((prev) => ({ ...prev, ...next }));
      // Lets the page clear row selection without this hook knowing about rows.
      onShapeChange?.();
    },
    [onShapeChange],
  );

  const resetFilters = useCallback(() => {
    setFilters(INITIAL);
    onShapeChange?.();
  }, [onShapeChange]);

  /**
   * Reset only what narrows the RESULT SET, keeping presentation preferences.
   *
   * Used when the reviewer selects an employee. That is a new question, not a
   * refinement, so carrying a leftover "Level 2 Verified" into it produces an
   * intersection nobody asked for — which is exactly how employee 6174 rendered
   * an empty table. Sort and page size describe how results are shown rather
   * than which results, so they survive deliberately.
   */
  const resetContentFilters = useCallback(() => {
    setFilters((prev) => ({
      ...INITIAL,
      sort: prev.sort,
      pageSize: prev.pageSize,
    }));
    onShapeChange?.();
  }, [onShapeChange]);

  /**
   * Restore a whole filter set in ONE state update (DOC-080 §12).
   *
   * Calling the individual setters in sequence would be wrong, not merely slower: each
   * one changes the query-shape key, and `useCursorHistory` resets pagination to page 1
   * during the render that sees a new key. Seven setters means up to seven shape changes,
   * each resetting the pager the restoration is about to position — and each an
   * opportunity for the queue query to fire against a half-restored shape. One update
   * produces one shape change, which the restoration state machine can then wait on.
   *
   * `onQueryShapeChange` is deliberately NOT fired here. Its only job is clearing row
   * selection, and restoration already starts from an empty selection — an old bulk
   * selection cannot survive a batch review whose data may have changed.
   */
  const restoreFilters = useCallback((next: ReviewQueueFilterState) => {
    setFilters({
      statuses: [...next.statuses],
      categories: [...next.categories],
      timePeriod: next.timePeriod,
      actionableOnly: next.actionableOnly,
      customFilters: next.customFilters.map((filter) => ({
        ...filter,
        values: [...filter.values],
      })),
      sort: next.sort,
      pageSize: next.pageSize,
    });
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.statuses.length) n += 1;
    if (filters.categories.length) n += 1;
    if (filters.timePeriod !== "all") n += 1;
    if (filters.actionableOnly) n += 1;
    n += filters.customFilters.length;
    return n;
  }, [filters]);

  return {
    filters,
    setStatuses: (statuses: string[]) => patch({ statuses }),
    setCategories: (categories: string[]) => patch({ categories }),
    setTimePeriod: (timePeriod: ReviewTimePeriod) => patch({ timePeriod }),
    setActionableOnly: (actionableOnly: boolean) => patch({ actionableOnly }),
    setCustomFilters: (customFilters: ReviewCustomFilter[]) => patch({ customFilters }),
    setSort: (sort: ReviewQueueSort) => patch({ sort }),
    setPageSize: (pageSize: number) => patch({ pageSize }),
    resetFilters,
    resetContentFilters,
    restoreFilters,
    activeFilterCount,
  };
}

/**
 * Stable identity for "what is being queried". Any change to this invalidates
 * every cached cursor, because a cursor only means something inside the exact
 * filtered ordering that produced it.
 */
export function buildQueryShapeKey(input: {
  organizationId: string | null;
  employeeUserId: string | null;
  generalSearch: string | null;
  statuses: string[];
  categories: string[];
  dateFrom: string | null;
  dateTo: string | null;
  actionableOnly: boolean;
  customFilters: ReviewCustomFilter[];
  sort: ReviewQueueSort;
  pageSize: number;
}): string {
  return JSON.stringify([
    input.organizationId,
    input.employeeUserId,
    input.generalSearch,
    [...input.statuses].sort(),
    [...input.categories].sort(),
    input.dateFrom,
    input.dateTo,
    input.actionableOnly,
    [...input.customFilters]
      .map((f) => ({ ...f, values: [...f.values].sort() }))
      .sort((a, b) => `${a.source}:${a.field_id}`.localeCompare(`${b.source}:${b.field_id}`)),
    input.sort,
    input.pageSize,
  ]);
}
