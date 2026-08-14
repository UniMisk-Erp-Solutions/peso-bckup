/**
 * React Query keys for Review Queue V2 (DOC-079).
 *
 * The page key includes every input that changes the server result, so a filter,
 * sort, cursor or page-size change produces a distinct key — which is what lets
 * React Query keep the previous page visible and cancel the stale request.
 */
import type {
  ReviewQueueCursorV2,
  ReviewQueueFiltersV2,
  ReviewQueueSortV2,
} from "./types";

/** Stable serialization so key equality does not depend on object key order. */
export function serializeFilters(filters?: ReviewQueueFiltersV2): string {
  const f = filters ?? {};
  return JSON.stringify({
    search: f.search ?? null,
    statuses: [...(f.statuses ?? [])].sort(),
    categories: [...(f.categories ?? [])].sort(),
    userIds: [...(f.userIds ?? [])].sort(),
    dateFrom: f.dateFrom ?? null,
    dateTo: f.dateTo ?? null,
    actionableOnly: f.actionableOnly ?? false,
    customFilters: [...(f.customFilters ?? [])]
      .map((c) => ({ source: c.source, field_id: c.field_id, values: [...c.values].sort() }))
      .sort((a, b) => (a.field_id < b.field_id ? -1 : a.field_id > b.field_id ? 1 : 0)),
  });
}

export const reviewQueueV2Keys = {
  all: (orgId: string, userId: string) => ["reviewQueueV2", orgId, userId] as const,

  capability: () => ["reviewQueueV2", "capability"] as const,

  filterOptions: (orgId: string, userId: string) =>
    [...reviewQueueV2Keys.all(orgId, userId), "filterOptions"] as const,

  page: (params: {
    orgId: string;
    userId: string;
    pageSize: number;
    sort: ReviewQueueSortV2;
    cursor: ReviewQueueCursorV2 | null;
    filters?: ReviewQueueFiltersV2;
  }) =>
    [
      ...reviewQueueV2Keys.all(params.orgId, params.userId),
      "page",
      params.pageSize,
      params.sort,
      params.cursor ? `${params.cursor.sort_at}|${params.cursor.id}` : "first",
      serializeFilters(params.filters),
    ] as const,

  detail: (orgId: string, userId: string, expenseId: string) =>
    [...reviewQueueV2Keys.all(orgId, userId), "detail", expenseId] as const,
};
