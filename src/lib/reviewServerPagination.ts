/**
 * True server-page-at-a-time Review pagination (DOC-080 §22-§27).
 *
 * Replaces the old bounded pre-download (FILTERED_MAX_PAGES × 100 = up to 300
 * rows sliced client-side). A status filter such as "Level 2 Verified" can match
 * thousands of rows, so pre-downloading 300 just to show page 1 is exactly the
 * behaviour §22 forbids. Instead, ONE visible page = ONE queue RPC call:
 *
 *  - Next uses the page's `next_cursor` — one keyset request.
 *  - Previous reuses the cursor that fetched the earlier page from the caller's
 *    cursor history — no re-download of intervening pages.
 *  - A direct page jump resolves the target page's cursor via the page-anchor
 *    RPC (one anchor call) then fetches it (one page call) — never a sequential
 *    walk from page 1.
 *
 * The server's actionability fields are still ignored here (search/visibility
 * transport only); EngineerReview stays authoritative for ready/waiting/completed
 * and Manager actions (§15). Rows arrive with employee identity + custom_fields +
 * resubmission/correction state already on them, so list rendering needs ZERO
 * enrichment (§20/§44).
 */

import { fetchReviewQueuePage, fetchReviewQueuePageAnchor } from "@/features/reviewQueueServer/api";
import { reviewQueueItemToExpense } from "@/lib/filteredReviewFetch";
import type {
  ReviewCustomFilter,
  ReviewQueueCursor,
  ReviewQueuePage,
  ReviewQueueSort,
} from "@/features/reviewQueueServer/types";
import type { Expense } from "@/pages/EngineerReview";

/** The default and only Review page size for server-query mode (§22/§51). */
export const SERVER_QUERY_PAGE_SIZE = 25;

/**
 * Hard ceiling for a single server-query page request. A Production incident
 * showed a filtered search that never resolved leaving the chip on "counting…"
 * forever with the old rows still on screen — indistinguishable from "Search did
 * nothing". Bounding the request converts a hang into a visible, retryable error
 * (§28) instead of an indefinite spinner.
 */
export const SERVER_QUERY_TIMEOUT_MS = 25_000;

/** The server-affecting query, already mapped to server param shapes. */
export type ServerQueryParams = {
  organizationId: string;
  employeeUserId?: string | null;
  generalSearch?: string | null;
  statuses?: string[] | null;
  categories?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sort: ReviewQueueSort;
  customFilters?: ReviewCustomFilter[];
};

export type ServerQueryPage = {
  rows: Expense[];
  filteredTotal: number;
  totalPages: number;
  hasMore: boolean;
  nextCursor: ReviewQueueCursor | null;
  /** Reconciled aggregates over the FILTERED population, or null on an older server (§28). */
  filteredSummary: ReviewQueuePage["filtered_summary"];
  selectedEmployee: ReviewQueuePage["selected_employee"];
};

function toServerQueuePageParams(params: ServerQueryParams) {
  return {
    organizationId: params.organizationId,
    employeeUserId: params.employeeUserId ?? null,
    generalSearch: params.generalSearch ?? null,
    statuses: params.statuses ?? null,
    categories: params.categories ?? null,
    dateFrom: params.dateFrom ?? null,
    dateTo: params.dateTo ?? null,
    sort: params.sort,
    customFilters: params.customFilters ?? [],
  };
}

/** Compute total pages from a server total and page size (never below 1 when there are rows). */
export function totalPagesFor(filteredTotal: number, pageSize: number): number {
  if (!Number.isFinite(filteredTotal) || filteredTotal <= 0) return 0;
  return Math.max(1, Math.ceil(filteredTotal / pageSize));
}

/** Fetch exactly ONE page at the given cursor (null = the first page). */
export async function fetchServerQueryPage(
  params: ServerQueryParams,
  opts: { cursor?: ReviewQueueCursor | null; pageSize?: number; signal?: AbortSignal },
): Promise<ServerQueryPage> {
  const pageSize = opts.pageSize ?? SERVER_QUERY_PAGE_SIZE;
  const page = await fetchReviewQueuePage({
    ...toServerQueuePageParams(params),
    pageSize,
    cursor: opts.cursor ?? null,
    signal: opts.signal,
  });
  return {
    rows: page.items.map(reviewQueueItemToExpense),
    filteredTotal: page.filtered_total,
    totalPages: page.total_pages > 0 ? page.total_pages : totalPagesFor(page.filtered_total, pageSize),
    hasMore: page.has_more,
    nextCursor: page.next_cursor,
    filteredSummary: page.filtered_summary,
    selectedEmployee: page.selected_employee,
  };
}

/**
 * Fetch a page by its 1-based number using the page-anchor RPC to resolve the
 * cursor immediately before it, then one ordinary page fetch (§26). Page 1 skips
 * the anchor call entirely (its cursor is always null).
 */
export async function fetchServerQueryPageByNumber(
  params: ServerQueryParams,
  opts: { targetPage: number; pageSize?: number; signal?: AbortSignal },
): Promise<{ page: ServerQueryPage; cursor: ReviewQueueCursor | null }> {
  const pageSize = opts.pageSize ?? SERVER_QUERY_PAGE_SIZE;
  const target = Math.max(1, Math.floor(opts.targetPage));
  if (target === 1) {
    const page = await fetchServerQueryPage(params, { cursor: null, pageSize, signal: opts.signal });
    return { page, cursor: null };
  }
  const anchor = await fetchReviewQueuePageAnchor({
    ...toServerQueuePageParams(params),
    pageSize,
    targetPage: target,
  });
  const page = await fetchServerQueryPage(params, {
    cursor: anchor.cursor,
    pageSize,
    signal: opts.signal,
  });
  return { page, cursor: anchor.cursor };
}

/**
 * Bounded cursor history so Previous never re-downloads earlier pages (§25).
 * `cursors[p]` is the cursor that FETCHES 1-based page `p` (page 1 → null). The
 * cap keeps the map from growing without bound during long paging sessions.
 */
export const CURSOR_HISTORY_MAX = 400;

export type CursorHistory = Map<number, ReviewQueueCursor | null>;

export function newCursorHistory(): CursorHistory {
  const m: CursorHistory = new Map();
  m.set(1, null);
  return m;
}

export function recordCursor(
  history: CursorHistory,
  page: number,
  cursor: ReviewQueueCursor | null,
): void {
  history.set(page, cursor);
  if (history.size > CURSOR_HISTORY_MAX) {
    // Drop the lowest-numbered entries except page 1 (its null cursor is free).
    const pages = [...history.keys()].filter((p) => p !== 1).sort((a, b) => a - b);
    while (history.size > CURSOR_HISTORY_MAX && pages.length > 0) {
      history.delete(pages.shift()!);
    }
  }
}
