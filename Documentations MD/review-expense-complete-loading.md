# DOC-073 — Review Expense Complete Loading Fix

**Doc ID:** DOC-073
**Date:** 2026-07-30
**Status:** complete
**Branch:** fix/review-expense-complete-loading
**No Production SQL was executed as part of this change.**

---

## Overview and Production Symptoms

The manager review queue (`/review`) was silently showing a truncated expense list.
Reviewers saw 1,512 expenses but the UI displayed "All expenses loaded" — while the
actual database contained 2,400+ visible expenses for their role.

Secondary symptoms:

- Page load showed a long spinner due to unbounded concurrent DB queries firing simultaneously.
- After approximately 16 seconds, some users saw HTTP 500 errors from the `get_resubmitted_expense_ids` RPC (large payload).
- The "Load All Expenses" button sometimes crashed with no error shown.
- After the crash, refreshing the page re-showed the wrong cached "all loaded" state.

---

## Root Cause Analysis

### Bug 1 — False `allLoaded` (EngineerReview.tsx)

**Location:** `src/pages/EngineerReview.tsx` line ~624 (pre-fix)

**Old code:**
```typescript
const fetchedAll = fetchingAll || !fetchLimit || expenseRows.length < fetchLimit;
```

When `fetchingAll = true` (user clicked "Load All"), `fetchedAll` was immediately
set to `true` regardless of how many rows the server actually returned. This caused
the UI to falsely display "All expenses loaded" even when the RPC capped results at
its server-side row limit (~500–1500 rows depending on RPC).

**Fix:**
```typescript
const fetchedAll = !fetchLimit
  ? expenseRows.length < REVIEW_INITIAL_FETCH_LIMIT
  : expenseRows.length < fetchLimit;
```
`complete = true` only when the server returned fewer rows than the limit we sent,
proving the result set is exhausted.

---

### Bug 2 — No Pagination

The "Load All" flow called the existing RPC with `fetchLimit = undefined` (no limit),
but Supabase RPCs have implicit server-side caps. The code assumed "no limit = all rows"
which was incorrect.

**Fix:** Added `src/lib/supabasePagination.ts` — a reusable sequential paginator
with PAGE_SIZE 250, MAX_PAGES 100 safety cap, deduplication by id, AbortSignal
support, and per-page progress callbacks. The new RPCs in the migration
(`list_manager_visible_review_expenses_page`) support keyset cursor pagination
for stable ordering under concurrent writes.

---

### Bug 3 — Wrong Translation Keys

**Location:** `src/pages/EngineerReview.tsx` lines ~721–724 (pre-fix)

**Old code:**
```typescript
t("panel.progress.loadAll")
t("panel.progress.loadingExpensesHint")
t("panel.progress.loadedCount", { ... })
```

These keys do not exist under `admin:panel.progress`. The actual keys live under
`admin:review.progress` (verified in `src/locales/en/admin.json`).

**Fix:** Replaced all three references with the correct `review.progress.*` keys.

---

### Bug 4 — Cache Truncation Bug

**Location:** `src/pages/EngineerReview.tsx` line ~678 (pre-fix)

```typescript
localStorage.setItem(lsKey, JSON.stringify({
  expenses: merged.slice(0, 200),
  allLoaded: fetchedAll,  // BUG: allLoaded=true even though only 200 of 1512 stored
}));
```

The localStorage cache stored only the first 200 rows but set `allLoaded: true`,
causing the stale-while-revalidate paint to show 200 expenses as "all loaded".

**Fix:** Added a `truncated` flag. When `stored.length < merged.length`, the cache
entry records `complete: false` and `truncated: true` regardless of `fetchedAll`.

---

### Bug 5 — Custom Field Query Storm

**Location:** `src/lib/expenseCustomFieldFilters.ts` → `fetchValueRowsForExpenseBatch`

The function used `Promise.all()` over all chunks simultaneously. With 1,500 expenses
and `SUPABASE_IN_QUERY_CHUNK_SIZE = 100`, this fired 15+ parallel DB queries at once,
causing connection pool saturation.

**Fix:** Added `runWithConcurrencyLimit` (a simple worker-pool helper) with
`MAX_CUSTOM_FIELD_CONCURRENCY = 3` and reduced `CUSTOM_FIELD_BATCH_SIZE = 25`.
Also added proper error handling: code `57014` (statement timeout) retries twice
with exponential back-off; code `42703` (schema-cache miss) falls back to the
no-org-filter query.

---

### Bug 6 — Resubmission RPC with All IDs

**Location:** `src/lib/supabaseInQuery.ts` → `fetchResubmittedExpenseIds`

The code passed ALL expense IDs to `get_resubmitted_expense_ids` in a single RPC
call. With 1,500 expenses this exceeded Supabase's payload limit and caused HTTP 500
after ~16 seconds.

**Fix:** Split expense IDs into chunks of `RESUBMISSION_RPC_CHUNK_SIZE = 200` and
run them with `RESUBMISSION_MAX_CONCURRENCY = 3`.

---

### Bug 7 — Concurrent Fallback Audit Log Storm

**Location:** `src/lib/supabaseInQuery.ts` → fallback block after RPC failure

When the RPC failed, the fallback fired all audit_logs chunks via `Promise.all()` —
same problem as Bug 5 (unbounded concurrency).

**Fix:** Fallback also uses `runConcurrent(tasks, RESUBMISSION_MAX_CONCURRENCY)`.

---

## Solution Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/lib/reviewExpenseTypes.ts` | Shared result types for the loading pipeline |
| `src/lib/supabasePagination.ts` | Reusable sequential paginator (PAGE_SIZE 250, MAX_PAGES 100) |
| `supabase/migrations/20260730_1200_manager_review_complete_pagination.sql` | Two new RPCs for count + keyset paginated list |
| `docs/sql/review-loading/01_review_expense_completeness_diagnostics.sql` | SELECT-only diagnostics |
| `docs/sql/review-loading/02_review_expense_index_verification.sql` | Index gap checker |
| `docs/sql/review-loading/03_review_expense_indexes_proposed.sql` | `CREATE INDEX CONCURRENTLY` statements (manual apply) |
| `src/lib/__tests__/reviewExpenseLoading.test.ts` | 15 test cases covering all bugs |

### Modified Files

| File | Change |
|------|--------|
| `src/pages/EngineerReview.tsx` | Fix allLoaded logic, translation keys, cache entry, sessionStorage guard |
| `src/lib/expenseCustomFieldFilters.ts` | Add concurrency pool, retry on 57014, schema-cache-only fallback |
| `src/lib/supabaseInQuery.ts` | Chunk RPC calls at ≤200, bounded concurrency in fallback |

---

## Migration Application Steps

1. Run `docs/sql/review-loading/02_review_expense_index_verification.sql` in the
   Supabase SQL editor to identify missing indexes.
2. Review `docs/sql/review-loading/03_review_expense_indexes_proposed.sql` with the
   DBA. Apply missing indexes manually using `CREATE INDEX CONCURRENTLY`.
3. Run `docs/sql/review-loading/01_review_expense_completeness_diagnostics.sql`
   to capture baseline counts before deploying.
4. Apply `supabase/migrations/20260730_1200_manager_review_complete_pagination.sql`
   via the Supabase migrations dashboard or `supabase db push`.
5. Verify the two new RPCs exist:
   ```sql
   SELECT routine_name FROM information_schema.routines
   WHERE routine_name IN (
     'count_manager_visible_review_expenses',
     'list_manager_visible_review_expenses_page'
   );
   ```
6. Deploy the frontend changes (this branch).
7. Spot-check: log in as a manager with 500+ visible expenses and verify the review
   queue loads completely.

---

## Rollback Procedure

### Frontend rollback

```bash
git revert HEAD  # or deploy previous build
```

### Database rollback (if needed)

```sql
-- Remove the two new RPCs; existing RPCs are untouched.
DROP FUNCTION IF EXISTS public.count_manager_visible_review_expenses(uuid);
DROP FUNCTION IF EXISTS public.list_manager_visible_review_expenses_page(uuid, timestamptz, uuid, integer);
```

The original `list_manager_pending_expenses` and `list_hierarchy_reviewer_expenses`
RPCs are **preserved** and used by the existing code paths.

---

## Production SQL Execution Status

**No production SQL was executed as part of this change.**

The migration SQL and index SQL files are provided for manual review and scheduled
application by the DBA. They must NOT be auto-applied by CI/CD without the diagnostic
checks in step 1–3 above.
