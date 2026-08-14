/**
 * Query keys for the server review queue (DOC-080).
 *
 * `scope` separates /review from /debug/review-expenses so the two surfaces never
 * share a cache entry — a stale debug page must not be able to feed the
 * production page, or vice versa.
 *
 * The page key contains only SUBMITTED values: draft employee-search text and
 * draft expense-search text are deliberately absent, so typing cannot invalidate
 * the key and cannot trigger a fetch.
 */

import type { ReviewCustomFilter, ReviewQueueCursor, ReviewQueueSort } from "./types";

export type ReviewQueueScope = "review" | "debug";

export function capabilitiesKey(scope: ReviewQueueScope) {
  return [scope, "review-queue", "capabilities"] as const;
}

export function filterOptionsKey(
  scope: ReviewQueueScope,
  organizationId: string | null,
  userId: string | null,
) {
  return [scope, "review-queue", "filter-options", organizationId, userId] as const;
}

export function expenseDetailKey(
  scope: ReviewQueueScope,
  organizationId: string | null,
  expenseId: string | null,
) {
  return [scope, "review-queue", "detail", organizationId, expenseId] as const;
}

export type ReviewQueuePageKeyInput = {
  organizationId: string | null;
  userId: string | null;
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
  cursor: ReviewQueueCursor | null;
};

export function reviewQueuePageKey(scope: ReviewQueueScope, i: ReviewQueuePageKeyInput) {
  return [
    scope,
    "review-queue",
    "page",
    i.organizationId,
    i.userId,
    i.employeeUserId,
    i.generalSearch,
    [...i.statuses].sort().join(","),
    [...i.categories].sort().join(","),
    i.dateFrom,
    i.dateTo,
    i.actionableOnly,
    // Stable serialization so equivalent filters share a cache entry.
    JSON.stringify(
      [...i.customFilters]
        .map((f) => ({ ...f, values: [...f.values].sort() }))
        .sort((a, b) => `${a.source}:${a.field_id}`.localeCompare(`${b.source}:${b.field_id}`)),
    ),
    i.sort,
    i.pageSize,
    i.cursor ? `${i.cursor.sk}|${i.cursor.id}` : null,
  ] as const;
}

/** Everything a successful mutation must invalidate: page rows AND scope summary. */
export function reviewQueueInvalidationPrefix(scope: ReviewQueueScope) {
  return [scope, "review-queue"] as const;
}
