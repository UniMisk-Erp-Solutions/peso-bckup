/**
 * Server-filtered Review fetch (DOC-080 §2-§9, §34-§35).
 *
 * When the reviewer submits an employee or a general search, we fetch ONLY the
 * matching rows from the installed server RPC (get_debug_review_queue_page_v1 via
 * reviewQueueServer/api.ts) instead of loading the whole reviewer scope and
 * filtering in the browser. Employee 6174 → ~30 rows, never ~9,244.
 *
 * The server rows are mapped onto the legacy `Expense` shape so they flow through
 * EngineerReview's existing render / selection / approval pipeline unchanged. The
 * server's actionability fields (is_actionable / view_only / available_actions)
 * are DELIBERATELY IGNORED here — this module is a search/visibility TRANSPORT
 * only; EngineerReview remains the authority for ready/waiting/completed and for
 * what a Manager may do (§4). Employee identity comes on the row, so filtered
 * rows never flash "—" (§39).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchReviewQueuePage } from "@/features/reviewQueueServer/api";
import type { ReviewQueueItem, ReviewQueueSort } from "@/features/reviewQueueServer/types";
import { resolveSubmitterEmployeeId } from "@/lib/supabaseInQuery";
import type { Expense } from "@/pages/EngineerReview";

/**
 * Interactive filtered load budget. A page size of 100 fetches an employee's
 * whole result (~30) in ONE request, while the low page cap bounds a broad
 * general search so it can never download thousands of rows before the page is
 * usable — at most FILTERED_MAX_PAGES × FILTERED_PAGE_SIZE rows are held, and
 * `truncated` is surfaced so the UI can say "showing the first N" (§9/§32/§46).
 */
export const FILTERED_MAX_PAGES = 3;
export const FILTERED_PAGE_SIZE = 100;

/** Map EngineerReview's (sortBy, sortOrder) to the server sort enum. */
export function engineerSortToServerSort(sortBy: string, sortOrder: string): ReviewQueueSort {
  const desc = sortOrder !== "asc";
  if (sortBy === "trip_start") return desc ? "expense_date_desc" : "expense_date_asc";
  // default: created_at
  return desc ? "created_desc" : "created_asc";
}

export function reviewQueueItemToExpense(item: ReviewQueueItem): Expense {
  const custom: Record<string, string> = {};
  for (const cf of item.custom_fields ?? []) {
    if (cf.value != null) custom[cf.field_key || cf.field_id] = cf.value;
  }
  const email = item.employee_email ?? "";
  const mapped = {
    id: item.id,
    title: item.title ?? "",
    destination: item.destination ?? "",
    trip_start: item.trip_start ?? "",
    trip_end: item.trip_start ?? "",
    status: item.status,
    total_amount: Number(item.total_amount ?? 0),
    created_at: item.created_at ?? "",
    user_id: item.user_id,
    user_name: item.employee_name ?? "",
    user_email: email,
    user_employee_id: resolveSubmitterEmployeeId(item.employee_id, email),
    user_balance: Number(item.current_balance ?? 0),
    purpose: item.purpose ?? "",
    category: item.category ?? null,
    approval_tier: item.approval_tier ?? null,
    wasReviewerCorrected: Boolean(item.was_reviewer_corrected),
    batch_id: item.batch_id ?? null,
    custom_fields: custom,
    // Extra fields the render pipeline reads via casts (not on the interface).
    transaction_number: item.transaction_number ?? undefined,
    isResubmitted: Boolean(item.is_resubmitted),
  } as Expense & { transaction_number?: string; isResubmitted?: boolean };
  return mapped;
}

export type FilteredReviewQuery = {
  organizationId: string;
  employeeUserId?: string | null;
  generalSearch?: string | null;
  statuses?: string[] | null;
  categories?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sort?: ReviewQueueSort;
  signal?: AbortSignal;
};

export type FilteredReviewResult = {
  rows: Expense[];
  /** Server-reported total matching the filter — the source of truth for counts/pages. */
  filteredTotal: number;
  /** True only if the guard cap stopped the load before exhausting the (bounded) filtered set. */
  truncated: boolean;
};

/**
 * Page through the filtered server result until exhausted, mapping to Expense.
 * This loads the FILTERED set only (bounded by the filter — an employee's rows,
 * a search's matches), never the full reviewer scope. Rows are de-duplicated by
 * id and returned in server (sort) order.
 */
export async function fetchFilteredReviewExpenses(
  supabase: SupabaseClient,
  query: FilteredReviewQuery,
): Promise<FilteredReviewResult> {
  const rows: Expense[] = [];
  const seen = new Set<string>();
  let cursor: Awaited<ReturnType<typeof fetchReviewQueuePage>>["next_cursor"] = null;
  let filteredTotal = 0;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (query.signal?.aborted) break;
    const page = await fetchReviewQueuePage({
      organizationId: query.organizationId,
      pageSize: FILTERED_PAGE_SIZE,
      cursor,
      sort: query.sort ?? "created_desc",
      employeeUserId: query.employeeUserId ?? null,
      generalSearch: query.generalSearch ?? null,
      statuses: query.statuses ?? null,
      categories: query.categories ?? null,
      dateFrom: query.dateFrom ?? null,
      dateTo: query.dateTo ?? null,
      signal: query.signal,
    });
    filteredTotal = page.filtered_total;

    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push(reviewQueueItemToExpense(item));
    }

    pages += 1;
    if (!page.has_more || !page.next_cursor) break;
    if (pages >= FILTERED_MAX_PAGES) {
      truncated = true;
      break;
    }
    cursor = page.next_cursor;
  }

  return { rows, filteredTotal, truncated };
}
