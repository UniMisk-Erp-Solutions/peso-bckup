/**
 * Offset pagination for the LEGACY review RPCs.
 *
 * Used when count_reviewer_visible_expenses / list_reviewer_visible_expenses_page
 * are not installed on the database (verified 404 / PGRST202). Those legacy RPCs
 * have no keyset cursor, so continuation is by explicit `.range(from, to)`.
 *
 * Why this exists separately from reviewExpensePagination.ts:
 *   The canonical path resumes from a keyset cursor. In legacy mode there is no
 *   cursor, so "Load All" needs its own resumable position — a per-source row
 *   offset. Reusing `nextCursor` for this is exactly what produced the silent
 *   no-op: a null cursor was read as "exhausted".
 *
 * Multi-source: a manager's legacy visibility is assembled from more than one
 * RPC. Each source carries its OWN offset and its own completion flag, because
 * one source running out says nothing about the others. Overall completion
 * requires every source to have returned a short page.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type LegacyReviewRow = Record<string, unknown>;

/** Page size for legacy range requests. Below PostgREST's 1000-row default cap. */
export const LEGACY_PAGE_SIZE = 250;
/** Rows pulled on the initial legacy load before we stop and wait for Load All. */
export const LEGACY_INITIAL_ROWS = 300;
/** Bounds a runaway loop; 200 x 250 = 50,000 rows of headroom. */
export const LEGACY_MAX_PAGES = 200;

/** Legacy RPCs that serve a hierarchy reviewer (executive / team leader). */
export const HIERARCHY_LEGACY_SOURCES = ["list_hierarchy_reviewer_expenses"] as const;
/** Legacy RPCs that together serve a manager / engineer reviewer. */
export const MANAGER_LEGACY_SOURCES = [
  "list_manager_pending_expenses",
  "list_manager_reviewer_expenses",
] as const;

/** Resumable position for one legacy source. */
export type LegacySourceCursor = {
  source: string;
  /** Next row offset to request. */
  nextOffset: number;
  /** True once this source returned a short page. */
  complete: boolean;
  error: string | null;
};

export function initLegacyCursors(sources: readonly string[]): LegacySourceCursor[] {
  return sources.map((source) => ({
    source,
    nextOffset: 0,
    complete: false,
    error: null,
  }));
}

/** Overall completion requires EVERY source to be exhausted. */
export function legacyCursorsComplete(cursors: LegacySourceCursor[]): boolean {
  return cursors.length > 0 && cursors.every((c) => c.complete);
}

export type LegacyLoadResult = {
  /** Newly fetched rows, deduplicated against `seenIds` and each other. */
  rows: LegacyReviewRow[];
  /** Updated per-source positions — pass these back in to continue. */
  cursors: LegacySourceCursor[];
  /** True only when every source returned a short page. */
  complete: boolean;
  pagesLoaded: number;
  error: string | null;
  aborted: boolean;
};

export type LegacyLoadOptions = {
  organizationId: string;
  cursors: LegacySourceCursor[];
  /** Rows already held by the caller, for cross-batch deduplication. */
  seenIds?: Set<string>;
  pageSize?: number;
  /** Stop once this many NEW rows have been collected (initial load uses 300). */
  maxRows?: number;
  maxPages?: number;
  signal?: AbortSignal;
  /**
   * Called after every successful page so the UI can append progressively. May
   * be async: the driver AWAITS it so a caller can hydrate identity before
   * committing a page (no "—" flash) and block the next fetch until it commits.
   */
  onPage?: (rows: LegacyReviewRow[], loaded: number) => void | Promise<void>;
};

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}

/**
 * Fetch one explicit range from one legacy RPC.
 * Always bounded — an unbounded call would be silently capped at 1000 rows.
 */
export async function fetchLegacyPage(
  supabase: SupabaseClient,
  source: string,
  organizationId: string,
  from: number,
  size: number,
): Promise<{ rows: LegacyReviewRow[]; shortPage: boolean; error: string | null }> {
  try {
    const { data, error } = await supabase
      .rpc(source, { p_organization_id: organizationId })
      .range(from, from + size - 1);

    if (error) {
      return { rows: [], shortPage: false, error: error.message };
    }
    const rows = (data ?? []) as LegacyReviewRow[];
    return { rows, shortPage: rows.length < size, error: null };
  } catch (err) {
    if (isAbort(err)) return { rows: [], shortPage: false, error: "aborted" };
    return {
      rows: [],
      shortPage: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Load legacy pages, resuming from each source's stored offset.
 *
 * Never restarts at offset 0 unless the supplied cursors say 0. A failure on a
 * later page keeps every row already collected and preserves the offset that
 * failed, so Retry resumes from exactly there.
 */
export async function loadLegacyReviewPages(
  supabase: SupabaseClient,
  options: LegacyLoadOptions,
): Promise<LegacyLoadResult> {
  const pageSize = options.pageSize ?? LEGACY_PAGE_SIZE;
  const maxPages = options.maxPages ?? LEGACY_MAX_PAGES;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const seen = options.seenIds ?? new Set<string>();

  // Copy so a failed run never mutates the caller's state in place.
  const cursors = options.cursors.map((c) => ({ ...c }));
  const collected: LegacyReviewRow[] = [];
  let pagesLoaded = 0;
  let error: string | null = null;
  let aborted = false;

  outer: for (const cursor of cursors) {
    while (!cursor.complete) {
      if (options.signal?.aborted) {
        aborted = true;
        break outer;
      }
      if (collected.length >= maxRows) break outer;
      if (pagesLoaded >= maxPages) break outer;

      // Never request more than the caller still wants.
      const remaining = maxRows - collected.length;
      const size = Math.max(1, Math.min(pageSize, remaining));

      const page = await fetchLegacyPage(
        supabase,
        cursor.source,
        options.organizationId,
        cursor.nextOffset,
        size,
      );

      if (page.error) {
        if (page.error === "aborted") {
          aborted = true;
        } else {
          cursor.error = page.error;
          error = page.error;
        }
        // Offset intentionally NOT advanced — Retry resumes from this page.
        break outer;
      }

      cursor.error = null;
      pagesLoaded++;
      cursor.nextOffset += page.rows.length;

      const fresh: LegacyReviewRow[] = [];
      for (const row of page.rows) {
        const id = row.id as string | undefined;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        fresh.push(row);
      }
      collected.push(...fresh);
      await options.onPage?.(fresh, seen.size);

      if (page.shortPage) {
        cursor.complete = true;
        break;
      }
      // A partial page caused by `maxRows` is not a short page — the source
      // still has more rows, so leave `complete` false and stop here.
      if (size < pageSize) break outer;
    }
  }

  return {
    rows: collected,
    cursors,
    complete: !error && !aborted && legacyCursorsComplete(cursors),
    pagesLoaded,
    error,
    aborted,
  };
}
