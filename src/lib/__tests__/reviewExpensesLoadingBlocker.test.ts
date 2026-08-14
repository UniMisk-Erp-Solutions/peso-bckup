/**
 * Tests for the Review Expenses loading blocker fix (DOC-074).
 *
 * The defect had three independent parts and this file covers all three:
 *   A. The server RPCs were manager-only, not cycle-safe, and unauthorized-callable.
 *   B. The client issued one unbounded RPC and silently accepted PostgREST's
 *      1000-row cap as "all the data".
 *   C. The UI waited for every optional enrichment request before rendering a
 *      single core row, so the page stayed blank for ~20s.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  cursorFromRow,
  isMissingFunctionError,
  isTrulyComplete,
  loadReviewerExpensePages,
  fetchReviewerVisibleCount,
  REVIEW_SERVER_PAGE_SIZE,
  REVIEW_MAX_PAGE_SIZE,
  CURSOR_EPOCH,
  type ReviewExpenseRow,
} from "../reviewExpensePagination";

const cwd = process.cwd();
const read = (p: string) => readFileSync(resolve(cwd, p), "utf-8");

const canonicalSql = read(
  "supabase/migrations/20260731090000_reviewer_visible_expenses_scope.sql",
);
const repairedSql = read(
  "supabase/migrations/20260730_1200_manager_review_complete_pagination.sql",
);
const engineerReview = read("src/pages/EngineerReview.tsx");
const hierarchyLib = read("src/lib/hierarchyReviewExpenses.ts");

/* ========================================================================== */
/* DATABASE MIGRATION                                                          */
/* ========================================================================== */

describe("migration — recursive CTE correctness", () => {
  it("1. uses WITH RECURSIVE, never a bare WITH, for the reporting tree", () => {
    expect(canonicalSql).toContain("WITH RECURSIVE");
    expect(repairedSql).toContain("WITH RECURSIVE");
    // A recursive self-reference under a non-recursive WITH is a hard SQL error.
    const bareWithBeforeRecursion = /\bWITH\s+(?!RECURSIVE)\w+\s+AS\s*\([^)]*reporting_tree/i;
    expect(bareWithBeforeRecursion.test(canonicalSql)).toBe(false);
  });

  it.each(["description", "amount", "currency"])(
    "2-4. never references the non-existent expenses column %s",
    (col) => {
      // public.expenses has no such column; the original migration failed on these.
      const ref = new RegExp(`\\be\\.${col}\\b`, "i");
      expect(ref.test(canonicalSql)).toBe(false);
      expect(ref.test(repairedSql)).toBe(false);
    },
  );

  it("5. page function returns SETOF public.expenses", () => {
    expect(canonicalSql).toMatch(
      /list_reviewer_visible_expenses_page[\s\S]*?RETURNS SETOF public\.expenses/,
    );
    expect(repairedSql).toMatch(
      /list_manager_visible_review_expenses_page[\s\S]*?RETURNS SETOF public\.expenses/,
    );
  });

  it("6. count and list share one visibility predicate helper", () => {
    const uses = canonicalSql.match(/public\.reviewer_visible_user_ids\(p_organization_id\)/g);
    // Once in the count function, once in the page function.
    expect(uses?.length).toBeGreaterThanOrEqual(2);
  });

  it("7. intersects candidates with ACTIVE organization memberships", () => {
    expect(canonicalSql).toMatch(/om\.is_active\s*=\s*true/);
  });

  it("8. recursive traversal is cycle-safe in BOTH count and list paths", () => {
    // The shared helper carries a visited array…
    expect(canonicalSql).toContain("visited");
    expect(canonicalSql).toMatch(/NOT \(op\.user_id = ANY \(rt\.visited\)\)/);
    // …and the repaired legacy migration guards both of its recursions.
    const guards = repairedSql.match(/= ANY \(rt\.visited\)/g);
    expect(guards?.length).toBe(2);
  });

  it("9-11. team visibility is role-aware for manager, executive and team leader", () => {
    expect(canonicalSql).toMatch(/t\.manager_user_id\s*=\s*auth\.uid\(\)/);
    expect(canonicalSql).toMatch(/t\.executive_user_id\s*=\s*auth\.uid\(\)/);
    expect(canonicalSql).toMatch(/t\.team_leader_user_id\s*=\s*auth\.uid\(\)/);
    // …and each is gated on the caller's actual role.
    expect(canonicalSql).toMatch(/c\.role::text\s*=\s*'executive'/);
    expect(canonicalSql).toMatch(/c\.role::text\s*=\s*'team_leader'/);
    expect(canonicalSql).toMatch(/c\.role::text IN \('engineer', 'manager'\)/);
  });

  it("compares app_role as text so an absent enum label cannot raise 22P02", () => {
    // organization_memberships.role is the app_role ENUM
    // ('admin','engineer','employee','team_leader','executive') — it has no
    // 'manager' label, so a bare enum literal comparison fails at parse time.
    const bareEnumCompare = /c\.role\s*(=|IN)\s*\(?'(?!.*::text)/;
    expect(bareEnumCompare.test(canonicalSql)).toBe(false);
  });

  it("12-13. revokes PUBLIC execute and grants only authenticated", () => {
    for (const fn of [
      "reviewer_visible_user_ids",
      "count_reviewer_visible_expenses",
      "list_reviewer_visible_expenses_page",
    ]) {
      expect(canonicalSql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]*FROM PUBLIC`));
      expect(canonicalSql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[^;]*TO authenticated`));
    }
  });

  it("14. SECURITY DEFINER functions still enforce org membership", () => {
    // Both entry points must re-check membership; SECURITY DEFINER alone would
    // let any authenticated user pass an arbitrary p_organization_id.
    const memberChecks = canonicalSql.match(
      /EXISTS \(\s*SELECT 1\s*FROM public\.organization_memberships om\s*WHERE om\.user_id = auth\.uid\(\)/g,
    );
    expect(memberChecks?.length).toBeGreaterThanOrEqual(2);
    expect(canonicalSql).toContain("SET search_path = public");
  });

  it("orders and cursors on COALESCE so nullable updated_at cannot skip rows", () => {
    expect(canonicalSql).toContain(
      "COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) DESC",
    );
    expect(repairedSql).toContain(
      "COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) DESC",
    );
  });

  it("caps page size at 1000 and defaults to 250", () => {
    expect(canonicalSql).toContain("p_page_size        integer     DEFAULT 250");
    expect(canonicalSql).toContain("LIMIT LEAST(GREATEST(COALESCE(p_page_size, 250), 1), 1000)");
  });
});

/* ========================================================================== */
/* PAGINATION                                                                  */
/* ========================================================================== */

type PageSpec = { rows: ReviewExpenseRow[]; error?: { message: string; code?: string } };

/** Minimal supabase double that records the arguments of each rpc() call. */
function makeSupabase(pages: PageSpec[], countValue: number | null = null) {
  const calls: Record<string, unknown>[] = [];
  let pageIndex = 0;
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, ...args });
      if (name === "count_reviewer_visible_expenses") {
        return Promise.resolve({ data: countValue, error: null });
      }
      const spec = pages[pageIndex++] ?? { rows: [] };
      return Promise.resolve({ data: spec.rows, error: spec.error ?? null });
    },
  };
  return { client: client as never, calls };
}

const mkRows = (n: number, startIdx = 0, updatedAt = "2026-07-30T10:00:00+00:00") =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${String(startIdx + i).padStart(5, "0")}`,
    updated_at: updatedAt,
    user_id: "u1",
    total_amount: 1,
  }));

describe("pagination — server cap and completion", () => {
  it("16. a full 1000-row page does not stop loading", async () => {
    // Exactly the PostgREST cap, then a short page.
    const { client } = makeSupabase([
      { rows: mkRows(1000, 0) },
      { rows: mkRows(12, 1000) },
    ]);
    const res = await loadReviewerExpensePages(client, {
      organizationId: "org",
      pageSize: 1000,
    });
    expect(res.rows).toHaveLength(1012);
    expect(res.complete).toBe(true);
  });

  it("17. loads 6,088 rows across all pages at the default page size", async () => {
    const total = 6088;
    const pages: PageSpec[] = [];
    for (let i = 0; i < total; i += REVIEW_SERVER_PAGE_SIZE) {
      pages.push({ rows: mkRows(Math.min(REVIEW_SERVER_PAGE_SIZE, total - i), i) });
    }
    const { client } = makeSupabase(pages, total);
    const res = await loadReviewerExpensePages(client, {
      organizationId: "org",
      total,
    });
    expect(res.rows).toHaveLength(total);
    expect(res.complete).toBe(true);
    expect(res.pagesLoaded).toBe(Math.ceil(total / REVIEW_SERVER_PAGE_SIZE));
    expect(isTrulyComplete(res.complete, res.rows.length, total)).toBe(true);
  });

  it("22. a short page marks completion and clears the cursor", async () => {
    const { client } = makeSupabase([{ rows: mkRows(3) }]);
    const res = await loadReviewerExpensePages(client, { organizationId: "org" });
    expect(res.complete).toBe(true);
    expect(res.nextCursor).toBeNull();
  });

  it("27. stops at the max-page guard instead of looping forever", async () => {
    const pages = Array.from({ length: 20 }, (_, p) => ({
      rows: mkRows(2, p * 2, `2026-07-${String(28 - p).padStart(2, "0")}T10:00:00+00:00`),
    }));
    const { client } = makeSupabase(pages);
    const res = await loadReviewerExpensePages(client, {
      organizationId: "org",
      pageSize: 2,
      maxPages: 3,
    });
    expect(res.pagesLoaded).toBe(3);
    expect(res.complete).toBe(false);
  });

  it("28. exact total stays separate from loaded count", () => {
    // 250 of 6088 loaded is NOT complete, even though the page was "successful".
    expect(isTrulyComplete(true, 250, 6088)).toBe(false);
    expect(isTrulyComplete(true, 6088, 6088)).toBe(true);
    // Tolerance absorbs concurrent writes, but not a 200-row shortfall.
    expect(isTrulyComplete(true, 6070, 6088)).toBe(true);
    expect(isTrulyComplete(true, 5888, 6088)).toBe(false);
    // A non-short page is never complete regardless of counts.
    expect(isTrulyComplete(false, 6088, 6088)).toBe(false);
  });
});

describe("pagination — async onPage is awaited (identity-before-commit)", () => {
  it("does not fetch the next page until an async onPage resolves", async () => {
    const { client, calls } = makeSupabase([
      { rows: mkRows(REVIEW_SERVER_PAGE_SIZE, 0) }, // full page → more to come
      { rows: mkRows(3, REVIEW_SERVER_PAGE_SIZE) }, // short page → done
    ]);
    const pageRpcCount = () =>
      calls.filter((c) => c.name === "list_reviewer_visible_expenses_page").length;

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    let onPageCalls = 0;

    const promise = loadReviewerExpensePages(client, {
      organizationId: "org",
      pageSize: REVIEW_SERVER_PAGE_SIZE,
      onPage: async () => {
        onPageCalls += 1;
        // Block after the FIRST page — mimics awaiting the identity fetch before
        // committing the page. The driver must not fetch page 2 until this
        // resolves, otherwise a caller could commit page 1 without identity.
        if (onPageCalls === 1) await firstGate;
      },
    });

    // Drain microtasks: page 1 is fetched and its onPage is now parked on the gate.
    await new Promise((r) => setTimeout(r, 0));
    expect(onPageCalls).toBe(1);
    expect(pageRpcCount()).toBe(1); // page 2 NOT fetched while onPage is pending

    releaseFirst();
    await promise;
    expect(pageRpcCount()).toBe(2); // page 2 fetched only after onPage resolved
  });
});

describe("pagination — cursor behaviour", () => {
  it("18/19. continues from the supplied cursor and never restarts at page 1", async () => {
    const { client, calls } = makeSupabase([{ rows: mkRows(2, 500) }]);
    const startCursor = { updatedAt: "2026-07-30T09:00:00+00:00", id: "id-00499" };
    await loadReviewerExpensePages(client, {
      organizationId: "org",
      startCursor,
      pageSize: 250,
    });
    const first = calls.find((c) => c.name === "list_reviewer_visible_expenses_page");
    expect(first?.p_after_updated_at).toBe(startCursor.updatedAt);
    expect(first?.p_after_id).toBe(startCursor.id);
  });

  it("20. removes duplicate ids across pages and against already-held rows", async () => {
    const dup = mkRows(2, 0);
    const { client } = makeSupabase([
      { rows: [...dup, ...mkRows(1, 2)] }, // page of 3
      { rows: mkRows(1, 3) },
    ]);
    const seen = new Set<string>(["id-00000"]); // caller already holds this row
    const res = await loadReviewerExpensePages(client, {
      organizationId: "org",
      pageSize: 3,
      seenIds: seen,
    });
    const ids = res.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("id-00000");
  });

  it("21. equal updated_at values paginate by id", async () => {
    const same = "2026-07-30T10:00:00+00:00";
    const { client, calls } = makeSupabase([
      { rows: mkRows(2, 0, same) },
      { rows: mkRows(1, 2, same) },
    ]);
    await loadReviewerExpensePages(client, { organizationId: "org", pageSize: 2 });
    const pageCalls = calls.filter((c) => c.name === "list_reviewer_visible_expenses_page");
    // Second request must carry the same timestamp but advance the id.
    expect(pageCalls[1].p_after_updated_at).toBe(same);
    expect(pageCalls[1].p_after_id).toBe("id-00001");
  });

  it("26. detects a stalled cursor and stops", async () => {
    // Server keeps returning the same full page — cursor never advances.
    const stuck = mkRows(2, 0);
    const { client } = makeSupabase([{ rows: stuck }, { rows: stuck }, { rows: stuck }]);
    const res = await loadReviewerExpensePages(client, {
      organizationId: "org",
      pageSize: 2,
    });
    expect(res.stalled).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.pagesLoaded).toBeLessThanOrEqual(2);
  });

  it("derives the cursor from COALESCE(updated_at, created_at, epoch)", () => {
    expect(cursorFromRow({ id: "a", updated_at: "T1" })?.updatedAt).toBe("T1");
    expect(cursorFromRow({ id: "a", updated_at: null, created_at: "T2" })?.updatedAt).toBe("T2");
    expect(cursorFromRow({ id: "a", updated_at: null, created_at: null })?.updatedAt).toBe(
      CURSOR_EPOCH,
    );
    expect(cursorFromRow({ updated_at: "T1" })).toBeNull();
  });
});

describe("pagination — failure, retry and abort", () => {
  it("23/24. a failed page keeps earlier rows and reports a resume cursor", async () => {
    const { client } = makeSupabase([
      { rows: mkRows(2, 0, "2026-07-30T10:00:00+00:00") },
      { rows: [], error: { message: "canceling statement due to statement timeout", code: "57014" } },
    ]);
    const res = await loadReviewerExpensePages(client, { organizationId: "org", pageSize: 2 });

    expect(res.rows).toHaveLength(2); // nothing lost
    expect(res.error).toMatch(/timeout/i);
    expect(res.complete).toBe(false);
    expect(res.nextCursor).toEqual({
      updatedAt: "2026-07-30T10:00:00+00:00",
      id: "id-00001",
    });

    // Retry resumes from exactly that cursor.
    const { client: c2, calls } = makeSupabase([{ rows: mkRows(1, 2) }]);
    await loadReviewerExpensePages(c2, {
      organizationId: "org",
      startCursor: res.nextCursor,
      pageSize: 2,
    });
    const retry = calls.find((c) => c.name === "list_reviewer_visible_expenses_page");
    expect(retry?.p_after_id).toBe("id-00001");
  });

  it("25. an aborted signal stops further requests", async () => {
    const controller = new AbortController();
    let requests = 0;
    const client = {
      rpc: () => {
        requests++;
        controller.abort(); // abort after the first page
        return Promise.resolve({ data: mkRows(2, requests * 2), error: null });
      },
    } as never;
    const res = await loadReviewerExpensePages(client, {
      organizationId: "org",
      pageSize: 2,
      signal: controller.signal,
    });
    expect(requests).toBe(1);
    expect(res.aborted).toBe(true);
    expect(res.complete).toBe(false);
  });

  it("falls back ONLY on verified missing-function errors", () => {
    expect(isMissingFunctionError({ message: "x", code: "PGRST202" })).toBe(true);
    expect(isMissingFunctionError({ message: "x", code: "42883" })).toBe(true);
    expect(
      isMissingFunctionError({
        message: "Could not find the function public.count_reviewer_visible_expenses",
      }),
    ).toBe(true);
    // These must NOT trigger a silent fallback.
    expect(isMissingFunctionError({ message: "statement timeout", code: "57014" })).toBe(false);
    expect(isMissingFunctionError({ message: "permission denied", code: "42501" })).toBe(false);
    expect(isMissingFunctionError({ message: "Failed to fetch" })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });

  it("reports the count RPC as missing without throwing", async () => {
    const client = {
      rpc: () =>
        Promise.resolve({ data: null, error: { message: "not in schema cache", code: "PGRST202" } }),
    } as never;
    const res = await fetchReviewerVisibleCount(client, "org");
    expect(res.missingFunction).toBe(true);
    expect(res.total).toBeNull();
  });

  it("never requests more than the hard 1000-row page cap", async () => {
    const { client, calls } = makeSupabase([{ rows: [] }]);
    await loadReviewerExpensePages(client, { organizationId: "org", pageSize: 99999 });
    const call = calls.find((c) => c.name === "list_reviewer_visible_expenses_page");
    expect(call?.p_page_size).toBe(REVIEW_MAX_PAGE_SIZE);
  });

  it("15. reports progress after every page so the UI can paint incrementally", async () => {
    const { client } = makeSupabase([
      { rows: mkRows(2, 0, "2026-07-30T12:00:00+00:00") },
      { rows: mkRows(2, 2, "2026-07-30T11:00:00+00:00") },
      { rows: mkRows(1, 4, "2026-07-30T10:00:00+00:00") },
    ]);
    const onPage = vi.fn();
    await loadReviewerExpensePages(client, { organizationId: "org", pageSize: 2, onPage });
    expect(onPage).toHaveBeenCalledTimes(3);
    // First callback fires with the FIRST page — not after everything finished.
    expect(onPage.mock.calls[0][0]).toHaveLength(2);
    expect(onPage.mock.calls[0][1].loaded).toBe(2);
  });

  it("respects pageLimit so the initial load does not pull everything", async () => {
    const pages = Array.from({ length: 10 }, (_, p) => ({
      rows: mkRows(2, p * 2, `2026-07-${String(28 - p).padStart(2, "0")}T10:00:00+00:00`),
    }));
    const { client } = makeSupabase(pages);
    const res = await loadReviewerExpensePages(client, {
      organizationId: "org",
      pageSize: 2,
      pageLimit: 2,
    });
    expect(res.pagesLoaded).toBe(2);
    expect(res.complete).toBe(false);
    expect(res.nextCursor).not.toBeNull();
  });
});

/* ========================================================================== */
/* UI PIPELINE                                                                 */
/* ========================================================================== */

describe("EngineerReview — identity hydrated before the first visible commit", () => {
  it("29. hydrates identity BEFORE committing core rows in the per-page callback", () => {
    const onPage = engineerReview.indexOf("onPage: async (freshRows) => {");
    expect(onPage).toBeGreaterThan(-1);
    // Identity is resolved and applied before the row is committed to visible
    // state, so a valid user_id never first renders "—" and then populates.
    const hydrate = engineerReview.indexOf("await hydrateRowsIdentity(", onPage);
    const commit = engineerReview.indexOf("setAllExpenses(snapshot)", onPage);
    expect(hydrate).toBeGreaterThan(onPage);
    expect(commit).toBeGreaterThan(hydrate);
  });

  it("29b. the page loaders await onPage so identity can complete before the next page", () => {
    const canonical = readFileSync(resolve(cwd, "src/lib/reviewExpensePagination.ts"), "utf-8");
    const legacy = readFileSync(resolve(cwd, "src/lib/legacyReviewPagination.ts"), "utf-8");
    expect(canonical).toContain("await options.onPage?.(");
    expect(legacy).toContain("await options.onPage?.(");
  });

  it("30-33. no enrichment call sits in the Promise.all that gates setAllExpenses", () => {
    // The old code awaited profiles + resubmitted + corrections + custom fields
    // in one Promise.all before the first setAllExpenses. That must be gone.
    expect(engineerReview).not.toContain(
      "const [profiles, resubmittedIds, reviewerCorrectedIds, customByExpense] = await Promise.all(",
    );
    // Enrichment is settled independently so one failure cannot drop rows.
    expect(engineerReview).toContain("await Promise.allSettled([");
  });

  it("31-33. failed optional lookups degrade to placeholders, never removing rows", () => {
    expect(engineerReview).toContain(
      'resubmittedRes.status === "fulfilled" ? resubmittedRes.value : new Set<string>()',
    );
    expect(engineerReview).toContain(
      'correctedRes.status === "fulfilled" ? correctedRes.value : new Set<string>()',
    );
    expect(engineerReview).toContain("setEnrichmentDegraded(anyOptionalFailed)");
  });

  it("34-35. enriches only the visible page (plus lookahead), re-running on page change", () => {
    expect(engineerReview).toContain("expenses.slice(start, start + REVIEW_PAGE_SIZE * 2)");
    const deps = engineerReview.slice(engineerReview.indexOf("const seq = ++enrichSeqRef.current"));
    expect(deps).toContain("currentPage");
  });

  it("36. discards stale enrichment responses", () => {
    expect(engineerReview).toContain("if (seq !== enrichSeqRef.current) return;");
  });

  it("37. merges enrichment in place without reordering or clearing", () => {
    expect(engineerReview).toContain("setAllExpenses((prev) => prev.map(patch))");
    expect(engineerReview).toContain("setExpenses((prev) => prev.map(patch))");
  });
});

/* ========================================================================== */
/* CACHE                                                                       */
/* ========================================================================== */

describe("EngineerReview — cache repair", () => {
  it("38. uses the v4 cache key and abandons identity-less earlier snapshots", () => {
    // v4 carries hydrated identity; v2/v3 stored identity-less rows that would
    // flash "—" on restore, so those keys must be gone.
    expect(engineerReview).toContain('"pesowise-review-v4"');
    expect(engineerReview).not.toContain("pesowise-review-v2");
    expect(engineerReview).not.toContain('"pesowise-review-v3"');
  });

  it("39/42. a truncated cache can never be reported as complete", () => {
    expect(engineerReview).toContain("Boolean(lsEntry.complete) && !lsEntry.truncated");
    expect(engineerReview).toContain("complete: entry.complete && !truncated");
  });

  it("40. rejects a cache written for another user, org or scope version", () => {
    expect(engineerReview).toContain("lsEntry.userId === user.id");
    expect(engineerReview).toContain("lsEntry.organizationId === organizationId");
    expect(engineerReview).toContain("lsEntry.scopeVersion === REVIEW_SCOPE_VERSION");
  });

  it("41. a truncated cache still carries the cursor needed to resume", () => {
    expect(engineerReview).toContain("setNextCursor(lsEntry.nextCursor ?? null)");
    expect(engineerReview).toContain("nextCursor: paged.nextCursor");
  });
});

/* ========================================================================== */
/* STATE SEPARATION + LEGACY PATH                                              */
/* ========================================================================== */

describe("EngineerReview — requested vs complete state", () => {
  it("keeps loadAllRequested and allExpensesLoaded as distinct concepts", () => {
    expect(engineerReview).toContain(
      'const [loadAllRequested, setLoadAllRequested] = useState(',
    );
    expect(engineerReview).toContain(
      "const [allExpensesLoaded, setAllExpensesLoaded] = useState(false)",
    );
    expect(engineerReview).toContain("const [totalAvailable, setTotalAvailable]");
    expect(engineerReview).toContain("const [nextCursor, setNextCursor]");
    expect(engineerReview).toContain("const [loadError, setLoadError]");
  });

  it("Load All progress uses the server total, never allExpenses.length twice", () => {
    // Canonical mode reports the real server total…
    expect(engineerReview).toContain("total: totalAvailable,");
    // …and when no total exists (legacy mode) it reports "N+" rather than
    // inventing one. Both fabricated forms must be absent.
    expect(engineerReview).not.toContain(
      "loaded: allExpenses.length, total: allExpenses.length",
    );
    expect(engineerReview).not.toContain("total: totalAvailable ?? allExpenses.length");
    expect(engineerReview).toContain("`Loaded ${allExpenses.length}+ expenses`");
  });

  it("offers Retry remaining and Keep current results on partial failure", () => {
    expect(engineerReview).toContain("Retry remaining");
    expect(engineerReview).toContain("Keep current results");
    expect(engineerReview).toContain("const handleRetryRemaining");
  });
});

describe("legacy fallback path is paged, never unbounded", () => {
  it("pages the legacy RPC with explicit ranges", () => {
    expect(hierarchyLib).toContain("LEGACY_RPC_PAGE_SIZE");
    expect(hierarchyLib).toContain(".range(from, from + size - 1)");
    // The old single unbounded call must be gone.
    expect(hierarchyLib).not.toMatch(
      /const \{ data: rpcRows, error: rpcError \} = await rpcQuery/,
    );
  });

  it("keeps the legacy page size under PostgREST's 1000-row cap", () => {
    const m = hierarchyLib.match(/LEGACY_RPC_PAGE_SIZE\s*=\s*(\d+)/);
    expect(Number(m?.[1])).toBeLessThan(1000);
  });
});
