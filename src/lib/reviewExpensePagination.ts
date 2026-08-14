/**
 * Canonical keyset pagination for the Review Expenses page.
 *
 * This module is the ONE path both hierarchy reviewers (executive / team_leader)
 * and managers use to read review expenses. It replaces the previous behaviour
 * where a single unbounded `.rpc(...)` call was issued and PostgREST silently
 * truncated the result at its default 1000-row cap.
 *
 * Guarantees:
 *  - Every request is explicitly bounded (page size <= 1000), so the 1000-row cap
 *    can never be mistaken for "the end of the data".
 *  - Load All continues from the last keyset cursor; it never restarts at page 1.
 *  - A failed page preserves every row already loaded and reports the cursor to
 *    resume from.
 *  - Completion is only claimed when a short page arrives AND the unique loaded
 *    count agrees with the server's own count RPC (within a small tolerance for
 *    rows written concurrently while we paginate).
 *  - Fallback to the legacy RPC happens ONLY on a verified missing-function /
 *    schema-cache error, never on a timeout or a permission error.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const REVIEW_SERVER_PAGE_SIZE = 250;
export const REVIEW_MAX_PAGE_SIZE = 1000;
/** 6,088 rows / 250 = ~25 pages. 200 leaves large headroom while still bounding runaway loops. */
export const REVIEW_MAX_PAGES = 200;
/**
 * Rows may be inserted/updated while we paginate. If the unique loaded count is
 * within this many rows of the server count, a short page is treated as complete.
 */
export const REVIEW_COUNT_TOLERANCE = 25;

export const COUNT_REVIEWER_RPC = "count_reviewer_visible_expenses";
export const LIST_REVIEWER_PAGE_RPC = "list_reviewer_visible_expenses_page";

export type ReviewExpenseRow = Record<string, unknown>;

/** Keyset cursor. `updatedAt` mirrors COALESCE(updated_at, created_at, epoch) server-side. */
export type ReviewCursor = { updatedAt: string; id: string };

export type SupabaseLikeError = { message: string; code?: string } | null;

export const CURSOR_EPOCH = "1970-01-01T00:00:00+00:00";

/**
 * Derive the keyset cursor value for a row.
 * expenses.updated_at is nullable, so this must mirror the server's
 * COALESCE(updated_at, created_at, 'epoch') ordering expression exactly.
 */
export function cursorFromRow(row: ReviewExpenseRow): ReviewCursor | null {
  const id = row.id as string | undefined;
  if (!id) return null;
  const updatedAt =
    (row.updated_at as string | null | undefined) ??
    (row.created_at as string | null | undefined) ??
    CURSOR_EPOCH;
  return { updatedAt, id };
}

/**
 * True only for errors proving the RPC does not exist on this database.
 * Timeouts, permission failures and network errors must NOT trigger the legacy
 * fallback — silently falling back on those would hide a real outage.
 */
export function isMissingFunctionError(error: SupabaseLikeError): boolean {
  if (!error) return false;
  // PGRST202 = PostgREST "function not found in schema cache".
  // 42883    = Postgres "undefined_function".
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const m = String(error.message ?? "");
  return (
    /could not find the function/i.test(m) ||
    /schema cache/i.test(m) ||
    /function .* does not exist/i.test(m) ||
    /undefined function/i.test(m)
  );
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  // An active signal is the strongest evidence of supersession. postgrest-js does
  // NOT guard JSON.parse on its success path, so an aborted 2xx whose body is
  // truncated surfaces as a SyntaxError, not an AbortError — treat anything thrown
  // while the signal is aborted as an abort so it is IGNORED, never a hard error.
  if (signal?.aborted) return true;
  // A browser AbortError is a DOMException, not `instanceof Error` — inspect
  // name/message structurally so an aborted fetch is never treated as a hard error.
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    const message = (error as { message?: unknown }).message;
    if (name === "AbortError") return true;
    if (typeof message === "string" && /abort/i.test(message)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Count                                                                       */
/* -------------------------------------------------------------------------- */

export type CountResult = {
  /** Server-reported total, or null when the count RPC is unavailable. */
  total: number | null;
  /** True when the count RPC is missing (caller should expect legacy fallback). */
  missingFunction: boolean;
  error: string | null;
};

export async function fetchReviewerVisibleCount(
  supabase: SupabaseClient,
  organizationId: string,
  signal?: AbortSignal,
): Promise<CountResult> {
  try {
    let q = supabase.rpc(COUNT_REVIEWER_RPC, { p_organization_id: organizationId });
    if (signal) q = (q as unknown as { abortSignal: (s: AbortSignal) => typeof q }).abortSignal(signal);
    const { data, error } = await q;

    if (error) {
      if (isMissingFunctionError(error)) {
        return { total: null, missingFunction: true, error: error.message };
      }
      return { total: null, missingFunction: false, error: error.message };
    }
    const n = Number(Array.isArray(data) ? data[0] : data);
    return {
      total: Number.isFinite(n) ? n : null,
      missingFunction: false,
      error: null,
    };
  } catch (err) {
    if (isAbortError(err, signal)) return { total: null, missingFunction: false, error: "aborted" };
    return {
      total: null,
      missingFunction: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Single page                                                                 */
/* -------------------------------------------------------------------------- */

export type PageResult = {
  rows: ReviewExpenseRow[];
  /** True when the server returned fewer rows than requested (end of data). */
  shortPage: boolean;
  missingFunction: boolean;
  error: string | null;
};

export type FetchPageParams = {
  organizationId: string;
  cursor?: ReviewCursor | null;
  pageSize?: number;
  signal?: AbortSignal;
};

/** Fetch one keyset page from the canonical RPC. */
export async function fetchReviewerExpensePage(
  supabase: SupabaseClient,
  params: FetchPageParams,
): Promise<PageResult> {
  const pageSize = Math.min(params.pageSize ?? REVIEW_SERVER_PAGE_SIZE, REVIEW_MAX_PAGE_SIZE);
  try {
    let q = supabase.rpc(LIST_REVIEWER_PAGE_RPC, {
      p_organization_id: params.organizationId,
      p_after_updated_at: params.cursor?.updatedAt ?? null,
      p_after_id: params.cursor?.id ?? null,
      p_page_size: pageSize,
    });
    if (params.signal) {
      q = (q as unknown as { abortSignal: (s: AbortSignal) => typeof q }).abortSignal(params.signal);
    }
    const { data, error } = await q;

    if (error) {
      return {
        rows: [],
        shortPage: false,
        missingFunction: isMissingFunctionError(error),
        error: error.message,
      };
    }
    const rows = (data ?? []) as ReviewExpenseRow[];
    return {
      rows,
      shortPage: rows.length < pageSize,
      missingFunction: false,
      error: null,
    };
  } catch (err) {
    if (isAbortError(err, params.signal)) {
      return { rows: [], shortPage: false, missingFunction: false, error: "aborted" };
    }
    return {
      rows: [],
      shortPage: false,
      missingFunction: false,
      // A truncated/incomplete 2xx body throws a SyntaxError from postgrest-js's
      // unguarded parse — keep it as a controlled retryable error, never a raw throw.
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Multi-page driver                                                           */
/* -------------------------------------------------------------------------- */

export type LoadProgress = {
  loaded: number;
  total: number | null;
  pages: number;
};

export type LoadPagesOptions = {
  organizationId: string;
  /** Resume point. Omit/null to start from the newest row. */
  startCursor?: ReviewCursor | null;
  /** Rows already held by the caller — used for cross-batch deduplication. */
  seenIds?: Set<string>;
  pageSize?: number;
  maxPages?: number;
  /** Stop after this many pages (initial load loads fewer pages than Load All). */
  pageLimit?: number;
  total?: number | null;
  signal?: AbortSignal;
  /**
   * Invoked after EVERY page so the UI can append incrementally. May be async:
   * the driver AWAITS it, so a caller that hydrates identity before committing a
   * page (no "—" flash) blocks the next page fetch until that page is committed.
   */
  onPage?: (rows: ReviewExpenseRow[], progress: LoadProgress) => void | Promise<void>;
};

export type LoadPagesResult = {
  /** Newly fetched, deduplicated rows (does not include previously seen rows). */
  rows: ReviewExpenseRow[];
  /** Cursor to resume from. Null once the data set is exhausted. */
  nextCursor: ReviewCursor | null;
  /** True only when the data set is genuinely exhausted. */
  complete: boolean;
  pagesLoaded: number;
  /** Set when a page failed; rows fetched before the failure are still returned. */
  error: string | null;
  missingFunction: boolean;
  aborted: boolean;
  /** True when the server stopped advancing the cursor (defensive stall guard). */
  stalled: boolean;
};

/**
 * Load pages sequentially from `startCursor`, appending as it goes.
 *
 * Never restarts at page 1: pass the previous `nextCursor` to continue.
 * On failure it returns everything loaded so far plus the cursor to retry from.
 */
export async function loadReviewerExpensePages(
  supabase: SupabaseClient,
  options: LoadPagesOptions,
): Promise<LoadPagesResult> {
  const pageSize = Math.min(options.pageSize ?? REVIEW_SERVER_PAGE_SIZE, REVIEW_MAX_PAGE_SIZE);
  const maxPages = options.maxPages ?? REVIEW_MAX_PAGES;
  const pageLimit = options.pageLimit ?? maxPages;
  const seen = options.seenIds ?? new Set<string>();
  const total = options.total ?? null;

  const collected: ReviewExpenseRow[] = [];
  let cursor: ReviewCursor | null = options.startCursor ?? null;
  let pagesLoaded = 0;
  let complete = false;
  let error: string | null = null;
  let missingFunction = false;
  let aborted = false;
  let stalled = false;

  while (pagesLoaded < Math.min(maxPages, pageLimit)) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }

    const page = await fetchReviewerExpensePage(supabase, {
      organizationId: options.organizationId,
      cursor,
      pageSize,
      signal: options.signal,
    });

    if (page.error) {
      if (page.error === "aborted") aborted = true;
      else {
        error = page.error;
        missingFunction = page.missingFunction;
      }
      break;
    }

    pagesLoaded++;

    // Deduplicate against rows the caller already holds and against this batch.
    const fresh: ReviewExpenseRow[] = [];
    for (const row of page.rows) {
      const id = row.id as string | undefined;
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push(row);
    }
    collected.push(...fresh);

    // Advance the cursor from the LAST row of the raw page (not the deduped list):
    // the server's ordering position is defined by what it actually returned.
    const lastRow = page.rows[page.rows.length - 1];
    const nextCursor = lastRow ? cursorFromRow(lastRow) : null;

    // Cursor-stall guard: if the server hands back the same position twice we
    // would loop forever requesting the same page.
    if (
      nextCursor &&
      cursor &&
      nextCursor.updatedAt === cursor.updatedAt &&
      nextCursor.id === cursor.id
    ) {
      stalled = true;
      break;
    }
    // A full page that yielded zero new rows also means we are not advancing.
    if (page.rows.length > 0 && fresh.length === 0 && !page.shortPage) {
      stalled = true;
      break;
    }

    cursor = nextCursor ?? cursor;

    await options.onPage?.(fresh, { loaded: seen.size, total, pages: pagesLoaded });

    if (page.shortPage) {
      complete = true;
      cursor = null;
      break;
    }
  }

  return {
    rows: collected,
    nextCursor: complete ? null : cursor,
    complete,
    pagesLoaded,
    error,
    missingFunction,
    aborted,
    stalled,
  };
}

/**
 * Decide whether a data set may truthfully be called complete.
 *
 * A short page alone is not enough when the server total is known: it must also
 * agree with the number of unique rows we actually hold.
 */
export function isTrulyComplete(
  shortPageReached: boolean,
  loadedUnique: number,
  total: number | null,
  tolerance: number = REVIEW_COUNT_TOLERANCE,
): boolean {
  if (!shortPageReached) return false;
  if (total === null) return true; // no count available — short page is the best signal we have
  return loadedUnique >= total - tolerance;
}
