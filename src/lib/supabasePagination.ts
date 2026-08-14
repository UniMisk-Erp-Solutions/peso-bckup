/**
 * Reusable sequential paginator for Supabase RPC calls and table queries.
 *
 * Design notes:
 * - PAGE_SIZE = 250 keeps each request well under PostgREST's default 1000-row cap
 *   and avoids HTTP 413 / 414 on large IN-clause filters.
 * - MAX_PAGES = 100 safety guard prevents infinite loops if server returns PAGE_SIZE
 *   rows indefinitely (e.g. a count mismatch bug on the server side).
 * - Pages are fetched SEQUENTIALLY, not concurrently, to avoid DB overload.
 * - Deduplication by `id` protects against keyset cursor drift on concurrent writes.
 * - AbortSignal support lets the caller cancel mid-flight (e.g. on component unmount).
 */

export const PAGINATION_PAGE_SIZE = 250;
export const PAGINATION_MAX_PAGES = 100;

export type PaginationResult<T> = {
  rows: T[];
  complete: boolean;
  pagesLoaded: number;
};

export type PaginationProgressCallback = (loaded: number, pageCount: number) => void;

type FetchPageFn<T> = (
  from: number,
  to: number,
  signal?: AbortSignal,
) => Promise<{ data: T[] | null; error: { message: string; code?: string } | null }>;

export interface PaginationOptions {
  pageSize?: number;
  maxPages?: number;
  onProgress?: PaginationProgressCallback;
  signal?: AbortSignal;
}

/**
 * Paginate a Supabase RPC or table query that returns an array of rows.
 * Uses offset-based pagination (range(from, to)).
 * Stops when a page returns fewer rows than PAGE_SIZE.
 */
export async function paginateSupabaseRpc<T>(
  fetchPage: FetchPageFn<T>,
  options?: PaginationOptions,
): Promise<PaginationResult<T>> {
  const pageSize = options?.pageSize ?? PAGINATION_PAGE_SIZE;
  const maxPages = options?.maxPages ?? PAGINATION_MAX_PAGES;
  const onProgress = options?.onProgress;
  const signal = options?.signal;

  const allRows: T[] = [];
  let pagesLoaded = 0;

  while (pagesLoaded < maxPages) {
    if (signal?.aborted) break;

    const from = pagesLoaded * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await fetchPage(from, to, signal);

    if (error) {
      console.warn("[paginateSupabaseRpc] page error:", error.message);
      break;
    }

    const page = data ?? [];
    allRows.push(...page);
    pagesLoaded++;

    onProgress?.(allRows.length, pagesLoaded);

    if (page.length < pageSize) {
      // Server returned fewer rows than asked — we've exhausted the result set.
      return { rows: allRows, complete: true, pagesLoaded };
    }
  }

  // Exited loop without a short page — either aborted or hit maxPages guard.
  return { rows: allRows, complete: false, pagesLoaded };
}

/**
 * Paginate a Supabase table query with deduplication by `id` field.
 * Use when rows may be updated concurrently and keyset drift is a concern.
 */
export async function paginateSupabaseTable<T extends { id?: string; updated_at?: string }>(
  fetchPage: FetchPageFn<T>,
  options?: PaginationOptions,
): Promise<PaginationResult<T>> {
  const result = await paginateSupabaseRpc(fetchPage, options);

  // Deduplicate by id (last-write-wins on duplicate id keeps most recent cursor position)
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of result.rows) {
    const id = row.id;
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    deduped.push(row);
  }

  return { ...result, rows: deduped };
}
