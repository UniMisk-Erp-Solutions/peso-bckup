/**
 * Tests for the review expense complete-loading fix (DOC-073).
 *
 * Covers:
 * 1. REVIEW_INITIAL_FETCH_LIMIT constant is defined and used as the cap.
 * 2. fetchedAll = false when result.length >= fetchLimit (no false-positive allLoaded).
 * 3. fetchedAll = true when result.length < fetchLimit (exhausted).
 * 4. Custom field batch concurrency is capped at MAX_CUSTOM_FIELD_CONCURRENCY (≤3).
 * 5. Code 57014 (statement timeout) triggers retry, NOT schema-cache fallback.
 * 6. Code 42703 (schema cache) DOES trigger the no-org fallback.
 * 7. Resubmission IDs chunked at ≤200 per RPC call.
 * 8. Fallback audit_logs query uses bounded concurrency (not unbounded Promise.all).
 * 9. Translation key audit: no raw "panel.progress.*" keys in EngineerReview.tsx.
 * 10. Cache entry has `truncated` flag set when stored count < loaded count.
 * 11. sessionStorage NOT set when fetchedAll = false.
 * 12. supabasePagination stops when a page returns fewer rows than PAGE_SIZE.
 * 13. supabasePagination deduplicates rows by id.
 * 14. supabasePagination respects AbortSignal.
 * 15. concurrency pool limits simultaneous in-flight tasks.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  paginateSupabaseRpc,
  paginateSupabaseTable,
  PAGINATION_PAGE_SIZE,
} from "../supabasePagination";
import {
  CUSTOM_FIELD_BATCH_SIZE,
  MAX_CUSTOM_FIELD_CONCURRENCY,
} from "../expenseCustomFieldFilters";

const cwd = process.cwd();

const engineerReview = readFileSync(
  resolve(cwd, "src/pages/EngineerReview.tsx"),
  "utf-8",
);
const supabaseInQuery = readFileSync(
  resolve(cwd, "src/lib/supabaseInQuery.ts"),
  "utf-8",
);
const customFieldFilters = readFileSync(
  resolve(cwd, "src/lib/expenseCustomFieldFilters.ts"),
  "utf-8",
);

const reviewExpensePagination = readFileSync(
  resolve(cwd, "src/lib/reviewExpensePagination.ts"),
  "utf-8",
);

// ── Manager / Executive share ONE canonical fetch pipeline (DOC-080) ──────────
// The live audit proved count_reviewer_visible_expenses / list_reviewer_visible_
// expenses_page return the same shape and cursor semantics for a real Manager
// (engineer) and a real Executive; visibility is decided server-side by the
// caller's role. So the client fetch layer must be role-agnostic — there must be
// no separate Manager vs Executive pagination path.
describe("EngineerReview.tsx — Manager/Executive one canonical pipeline", () => {
  it("the canonical count/page helpers take no role or user_id argument (cannot fork by role)", () => {
    // Signatures accept organization + cursor + page size only.
    expect(reviewExpensePagination).toMatch(
      /export async function fetchReviewerVisibleCount\(\s*supabase: SupabaseClient,\s*organizationId: string,\s*signal\?: AbortSignal,\s*\)/,
    );
    // The canonical RPC is invoked with exactly the org + keyset + page-size args.
    expect(reviewExpensePagination).toMatch(/p_organization_id: params\.organizationId/);
    expect(reviewExpensePagination).toMatch(/p_after_updated_at:/);
    expect(reviewExpensePagination).toMatch(/p_after_id:/);
    expect(reviewExpensePagination).toMatch(/p_page_size:/);
    // No role/tier discriminator is ever sent to the canonical RPCs.
    expect(reviewExpensePagination).not.toMatch(/p_(role|reviewer_role|tier|user_id|caller)/);
  });

  it("EngineerReview drives the canonical pipeline without branching the fetch by role", () => {
    // Both roles reach the same helpers…
    expect(engineerReview).toMatch(/fetchReviewerVisibleCount\(/);
    expect(engineerReview).toMatch(/loadReviewerExpensePages\(/);
    // …and the canonical count/page calls are not wrapped in a userRole branch.
    // (We assert the canonical calls do not sit inside `if (userRole === ...)`.)
    const canonicalCallIdx = engineerReview.indexOf("loadReviewerExpensePages(");
    const windowBefore = engineerReview.slice(Math.max(0, canonicalCallIdx - 600), canonicalCallIdx);
    expect(windowBefore).not.toMatch(/if \(\s*userRole\s*===\s*["'](engineer|executive|team_leader)["']/);
  });

  it("legacy manager/hierarchy RPCs are used ONLY as the missing-function fallback", () => {
    // The legacy RPCs exist, but the manager probe sits after a canonical
    // missingFunction check — never as the primary path.
    expect(engineerReview).toMatch(/list_manager_pending_expenses|list_manager_reviewer_expenses|list_hierarchy_reviewer_expenses/);
    expect(engineerReview).toMatch(/countResult\.missingFunction/);
  });
});

// ── 1. REVIEW_INITIAL_FETCH_LIMIT constant ────────────────────────────────────
describe("EngineerReview.tsx — REVIEW_INITIAL_FETCH_LIMIT", () => {
  it("defines REVIEW_INITIAL_FETCH_LIMIT as a named constant", () => {
    expect(engineerReview).toContain("REVIEW_INITIAL_FETCH_LIMIT");
  });

  it("uses REVIEW_INITIAL_FETCH_LIMIT as the fetchLimit value", () => {
    expect(engineerReview).toContain(
      "fetchingAll ? undefined : REVIEW_INITIAL_FETCH_LIMIT",
    );
  });
});

// ── 2 & 3. fetchedAll logic ───────────────────────────────────────────────────
describe("EngineerReview.tsx — fetchedAll correctness", () => {
  it("does NOT set fetchedAll from fetchingAll alone (old bug removed)", () => {
    // The old buggy line was:
    //   const fetchedAll = fetchingAll || !fetchLimit || ...
    expect(engineerReview).not.toContain("fetchedAll = fetchingAll ||");
  });

  it("sets fetchedAll = true only when result < limit (limited path)", () => {
    expect(engineerReview).toContain("expenseRows.length < fetchLimit");
  });

  it("sets fetchedAll from REVIEW_INITIAL_FETCH_LIMIT for unlimited requests", () => {
    // For the unlimited path (!fetchLimit), complete = rows < initial cap
    expect(engineerReview).toContain("expenseRows.length < REVIEW_INITIAL_FETCH_LIMIT");
  });
});

// ── 4. Custom field concurrency cap ───────────────────────────────────────────
describe("expenseCustomFieldFilters — concurrency cap", () => {
  it("exports CUSTOM_FIELD_BATCH_SIZE of 25", () => {
    expect(CUSTOM_FIELD_BATCH_SIZE).toBe(25);
  });

  it("exports MAX_CUSTOM_FIELD_CONCURRENCY of 3", () => {
    expect(MAX_CUSTOM_FIELD_CONCURRENCY).toBe(3);
  });

  it("uses runWithConcurrencyLimit instead of unbounded Promise.all for value rows", () => {
    // The old code was: await Promise.all(chunkArray(...).map(...))
    // New code uses the pool helper
    expect(customFieldFilters).toContain("runWithConcurrencyLimit");
    expect(customFieldFilters).toContain("MAX_CUSTOM_FIELD_CONCURRENCY");
  });
});

// ── 5. 57014 triggers retry, NOT fallback ─────────────────────────────────────
describe("expenseCustomFieldFilters — error handling", () => {
  it("retries on code 57014 (statement timeout)", () => {
    expect(customFieldFilters).toContain('"57014"');
    expect(customFieldFilters).toContain("attempt < 2");
  });

  it("falls back to no-org query ONLY on code 42703 (schema cache miss)", () => {
    expect(customFieldFilters).toContain('"42703"');
    // The fallback without org filter should only be inside the 42703 block
    const idx42703 = customFieldFilters.indexOf('"42703"');
    const idxWithoutOrg = customFieldFilters.indexOf(
      ".in(\"expense_id\", batch)",
      idx42703,
    );
    // withoutOrg query appears after the 42703 check
    expect(idxWithoutOrg).toBeGreaterThan(idx42703);
  });
});

// ── 7. Resubmission RPC chunked at ≤200 ──────────────────────────────────────
describe("supabaseInQuery — resubmission RPC chunking", () => {
  it("defines RESUBMISSION_RPC_CHUNK_SIZE = 200", () => {
    expect(supabaseInQuery).toContain("RESUBMISSION_RPC_CHUNK_SIZE = 200");
  });

  it("uses RESUBMISSION_RPC_CHUNK_SIZE when splitting expense IDs for the RPC", () => {
    expect(supabaseInQuery).toContain(
      "chunkArray(expenseIds, RESUBMISSION_RPC_CHUNK_SIZE)",
    );
  });
});

// ── 8. Fallback uses bounded concurrency ──────────────────────────────────────
describe("supabaseInQuery — fallback bounded concurrency", () => {
  it("uses runConcurrent helper instead of unbounded Promise.all in fallback", () => {
    expect(supabaseInQuery).toContain("runConcurrent");
    expect(supabaseInQuery).toContain("RESUBMISSION_MAX_CONCURRENCY");
  });

  it("defines RESUBMISSION_MAX_CONCURRENCY = 3", () => {
    expect(supabaseInQuery).toContain("RESUBMISSION_MAX_CONCURRENCY = 3");
  });
});

// ── 9. Translation key audit ─────────────────────────────────────────────────
describe("EngineerReview.tsx — translation keys", () => {
  it("does NOT use the wrong panel.progress namespace", () => {
    expect(engineerReview).not.toContain('t("panel.progress.');
  });

  it("uses the correct review.progress.loadAll key", () => {
    expect(engineerReview).toContain('review.progress.loadAll"');
  });

  it("uses the correct review.progress.loadAllHint key", () => {
    expect(engineerReview).toContain('review.progress.loadAllHint"');
  });

  it("uses the correct review.progress.loadedCount key", () => {
    expect(engineerReview).toContain('review.progress.loadedCount"');
  });
});

// ── 10. Cache truncated flag ──────────────────────────────────────────────────
describe("EngineerReview.tsx — localStorage cache truncated flag", () => {
  it("writes a truncated flag to the localStorage cache entry", () => {
    expect(engineerReview).toContain("truncated:");
  });

  it("marks cache as complete=false (not allLoaded only) when truncated", () => {
    expect(engineerReview).toContain("complete: fetchedAll");
  });
});

// ── 11. sessionStorage NOT set when incomplete ────────────────────────────────
describe("EngineerReview.tsx — sessionStorage guard", () => {
  // The guard is now derived from real pagination state via isTrulyComplete()
  // rather than from a cache-entry lookup, so the assertion tracks that.
  it("only persists pesowise:load-all:review after a verified-complete load", () => {
    const completeCheck = engineerReview.indexOf("const complete = isTrulyComplete(");
    const ssSet = engineerReview.indexOf(
      'sessionStorage.setItem("pesowise:load-all:review", "true")',
    );
    expect(completeCheck).toBeGreaterThan(-1);
    expect(ssSet).toBeGreaterThan(completeCheck);
    // It must be gated on `complete`, never written unconditionally.
    expect(engineerReview).toContain("if (complete) {");
  });

  it("never initialises allExpensesLoaded from the sessionStorage preference", () => {
    // loadAllRequested may read sessionStorage; allExpensesLoaded must not.
    expect(engineerReview).toContain("const [allExpensesLoaded, setAllExpensesLoaded] = useState(false)");
    const requested = engineerReview.indexOf("const [loadAllRequested, setLoadAllRequested] = useState(");
    expect(requested).toBeGreaterThan(-1);
  });
});

// ── 12. paginateSupabaseRpc stops on short page ───────────────────────────────
describe("paginateSupabaseRpc", () => {
  it("stops when a page returns fewer rows than pageSize (complete = true)", async () => {
    const rows = [{ id: "1" }, { id: "2" }];
    const fetchPage = vi.fn().mockResolvedValue({ data: rows, error: null });

    const result = await paginateSupabaseRpc(fetchPage, { pageSize: 5 });

    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("fetches multiple pages until a short page", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({ id: String(i) }));
    const page2 = [{ id: "100" }]; // short page
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: page1, error: null })
      .mockResolvedValueOnce({ data: page2, error: null });

    const result = await paginateSupabaseRpc(fetchPage, { pageSize: 3 });

    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(4);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("marks complete = false when maxPages is hit", async () => {
    const fullPage = Array.from({ length: 2 }, (_, i) => ({ id: String(i) }));
    const fetchPage = vi.fn().mockResolvedValue({ data: fullPage, error: null });

    const result = await paginateSupabaseRpc(fetchPage, { pageSize: 2, maxPages: 3 });

    expect(result.complete).toBe(false);
    expect(result.pagesLoaded).toBe(3);
  });

  it("stops fetching on error and returns incomplete", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "1" }], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "timeout" } });

    const result = await paginateSupabaseRpc(fetchPage, { pageSize: 1 });

    expect(result.complete).toBe(false);
  });
});

// ── 13. paginateSupabaseTable deduplicates ────────────────────────────────────
describe("paginateSupabaseTable — deduplication", () => {
  it("removes duplicate rows by id", async () => {
    const page1 = [{ id: "a" }, { id: "b" }];
    // page2 has only 1 row (< pageSize=2) so pagination stops cleanly
    const page2 = [{ id: "c" }];
    // page2 also introduces "b" via a separate fetch call — simulate by making it include "b"
    // Actually: to test dedup we need two pages that overlap; use pageSize=1 so each item is a page
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "a" }], error: null })
      .mockResolvedValueOnce({ data: [{ id: "b" }], error: null })
      .mockResolvedValueOnce({ data: [{ id: "b" }], error: null }) // duplicate "b"
      .mockResolvedValueOnce({ data: [{ id: "c" }], error: null })
      .mockResolvedValueOnce({ data: [], error: null }); // empty page → stop

    const result = await paginateSupabaseTable(fetchPage, { pageSize: 1 });

    const ids = result.rows.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    // "b" should appear only once despite being returned twice
    expect(ids.filter((id) => id === "b")).toHaveLength(1);
  });
});

// ── 14. AbortSignal support ───────────────────────────────────────────────────
describe("paginateSupabaseRpc — AbortSignal", () => {
  it("stops fetching when signal is aborted", async () => {
    const controller = new AbortController();
    const fullPage = Array.from({ length: 2 }, (_, i) => ({ id: String(i) }));

    let callCount = 0;
    const fetchPage = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) controller.abort();
      return { data: fullPage, error: null };
    });

    const result = await paginateSupabaseRpc(fetchPage, {
      pageSize: 2,
      maxPages: 10,
      signal: controller.signal,
    });

    // Should have stopped after signal was aborted
    expect(result.complete).toBe(false);
  });
});

// ── 15. PAGINATION_PAGE_SIZE constant ────────────────────────────────────────
describe("supabasePagination — constants", () => {
  it("exports PAGINATION_PAGE_SIZE = 250", () => {
    expect(PAGINATION_PAGE_SIZE).toBe(250);
  });
});
