# DOC-074 — Review Expenses Loading Blocker

**Date:** 2026-07-31
**Branch:** `fix/review-expenses-loading-blocker`
**Supersedes the incomplete parts of:** DOC-073 (Review Expense Complete Loading Fix)
**Production SQL executed:** **No.**

---

## 1. Symptom

`https://ml.pesowise.unimisk.com/review` stayed blank for a very long time for
executive reviewers. Kunvar Thakor (executive, 226-person hierarchy, ~6,088
expenses) saw roughly 1,512 rows at best, and only after a long full-screen
loading state.

## 2. Root causes

There were three independent defects. Fixing any one alone would not have fixed
the page.

### 2.1 Blank page — enrichment gated the table

`EngineerReview.tsx` awaited a single `Promise.all` containing **four** optional
enrichment lookups — submitter profiles, resubmitted ids, reviewer-correction
ids, and custom fields — and only called `setAllExpenses` *after* all four
resolved.

Custom fields are fetched 25 expense-ids per request with a concurrency of 3. For
1,512 rows that is ~61 requests in ~21 sequential rounds. The HAR shows **19.5
seconds** between the core RPC completing and the last enrichment request
finishing. For the whole of that window `loading` was `true` and not one core row
was on screen.

### 2.2 The 1,512-row ceiling — PostgREST's 1000-row cap

`fetchHierarchyReviewerExpenses` called `list_hierarchy_reviewer_expenses` once,
with **no `.range()`** whenever `fetchLimit` was undefined. PostgREST caps such a
request at 1000 rows. The HAR confirms it exactly:

| Request | Content-Range |
|---|---|
| `rpc/list_hierarchy_reviewer_expenses` | `0-999/*` |
| `audit_logs` (reviewer history) | `0-523/*` |

1000 assigned rows + ~512 unique history rows ≈ **1,512** — the number reported.
Nothing in the code could tell that truncation apart from "there are only 1000
rows", so `Load All` re-read the same capped window and never advanced.

`src/lib/supabasePagination.ts` (added in DOC-073) was never imported by the
fetch path — it existed only in its own tests.

### 2.3 Wrong scope — the RPC never included the hierarchy

`list_hierarchy_reviewer_expenses` returns rows **assigned to** the reviewer plus
rows they previously actioned. It does not walk the reporting tree at all, so a
226-person hierarchy could never yield 6,088 rows through it.

The 2026-07-30 migration meant to fix this, but:

* the filename `20260730_1200_…` has no 14-digit prefix, so the Supabase CLI
  **ignores it** (`npm run migrations:check` lists it as non-standard);
* team visibility used only `teams.manager_user_id` — wrong for an executive;
* the count function's recursive CTE had no cycle guard, so count and page could
  disagree;
* it did not verify the caller's active membership despite being SECURITY DEFINER.

Earlier repairs (already committed locally) had fixed `WITH` → `WITH RECURSIVE`
and the hand-written record type that referenced the non-existent `description`,
`amount` and `currency` columns.

### 2.4 Not a cause

The HAR also contains 1,469 failed `auth/v1/token` calls. Every one is
`net::ERR_INTERNET_DISCONNECTED` — the client was genuinely offline for ~29
seconds. The realtime WebSocket disconnects and the browser-extension
`runtime.lastError` noise are likewise unrelated. The core requests all returned
HTTP 200.

---

## 3. What changed

### 3.1 Database — canonical role-aware scope

New migration `20260731090000_reviewer_visible_expenses_scope.sql`:

| Function | Purpose |
|---|---|
| `reviewer_visible_user_ids(uuid)` | The one definition of "whose expenses may this reviewer see" |
| `count_reviewer_visible_expenses(uuid)` | Exact authorized total |
| `list_reviewer_visible_expenses_page(uuid, timestamptz, uuid, integer)` | Keyset page, `SETOF public.expenses` |

* Count and page both call the **same helper**, so their predicates cannot drift.
* Role-aware teams: `manager_user_id` for engineer/manager, `executive_user_id`
  for executive, `team_leader_user_id` for team leader.
* Recursive reporting tree with a `visited` array (cycle-safe, depth-bounded, no
  fixed depth assumption), intersected with **active** memberships.
* Membership re-checked inside every function — SECURITY DEFINER never bypasses
  authorization.
* `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO authenticated`.
* Order and cursor both use `COALESCE(updated_at, created_at, 'epoch')` because
  `expenses.updated_at` is **nullable**; the bare column would skip those rows
  permanently.
* Page size default 250, hard maximum 1000.

`20260730_1200_…` is repaired in place (cycle guard in the count function,
membership check, COALESCE ordering) so a fresh database still migrates, and is
marked superseded.

### 3.2 Client — real pagination

New `src/lib/reviewExpensePagination.ts` is now the single path used by both
hierarchy reviewers and managers:

* every request is explicitly bounded — the 1000-row cap can no longer be
  mistaken for the end of the data;
* `Load All` resumes from `nextCursor`; it never restarts at page 1;
* rows are deduplicated by id across pages and against rows already held;
* a failed page keeps every earlier row and returns the cursor to retry from;
* abort, max-page guard and cursor-stall detection;
* completion requires a short page **and** agreement with the count RPC
  (±25 rows for concurrent writes);
* fallback to the legacy RPC happens **only** on `PGRST202` / `42883` /
  "schema cache" errors — never on a timeout or permission failure.

The legacy path in `hierarchyReviewExpenses.ts` is now itself paged with explicit
ranges (500/page), for both the RPC and its table fallback.

### 3.3 Client — core rows before enrichment

* Core rows are committed to React state **inside the per-page callback**, before
  any enrichment starts.
* Enrichment covers the current page of 25, one page of lookahead, and the
  selected expense — not all 6,088.
* Enrichment uses `Promise.allSettled`, so a failed profile / badge / custom-field
  lookup can never remove a core row.
* Results merge in place: no reordering, no page reset, no scroll reset, no
  clearing. Stale responses are discarded by sequence number.
* Profiles are cached by `user_id`, enrichment by `expense_id`.

### 3.4 Client — requested vs. complete state

`allExpensesLoaded` is **no longer** initialised from
`sessionStorage["pesowise:load-all:review"]`. That preference now feeds a separate
`loadAllRequested` flag meaning "keep loading during this session". Completion is
tracked independently, alongside `totalAvailable`, `loadedCount`, `nextCursor`
and `loadError`. The session preference is only written after a verified-complete
load.

### 3.5 Cache

Key bumped to `pesowise-review-v3`. v2 entries could hold 200 rows while claiming
`allLoaded: true`, so they are abandoned rather than migrated. Entries now carry
`totalAvailable`, `complete`, `truncated`, `nextCursor`, `organizationId`,
`userId` and `scopeVersion`, and are rejected on any mismatch. A truncated cache
can never be reported as complete.

### 3.6 Custom-field filters (Option B)

Because enrichment is page-local, a custom-field filter can only see enriched
rows. The UI now says so explicitly and points at "Load all older expenses";
once the full set is loaded, remaining custom fields are fetched in bounded
batches (25 ids, max 3 concurrent) so the filter result becomes genuinely
complete. Incomplete results are never presented as complete.

---

## 4. Files

**Created**
- `supabase/migrations/20260731090000_reviewer_visible_expenses_scope.sql`
- `src/lib/reviewExpensePagination.ts`
- `src/lib/__tests__/reviewExpensesLoadingBlocker.test.ts`
- `docs/sql/review-loading/04_reviewer_scope_state_diagnostics.sql`
- `docs/sql/review-loading/05_reviewer_scope_index_verification.sql`
- `docs/sql/review-loading/06_reviewer_scope_production_apply.sql`

**Modified**
- `supabase/migrations/20260730_1200_manager_review_complete_pagination.sql`
- `src/pages/EngineerReview.tsx`
- `src/lib/hierarchyReviewExpenses.ts`
- `src/lib/__tests__/reviewExpenseLoading.test.ts`

---

## 5. Validation

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run typecheck:api` | pass |
| `npm test -- --run` | **1604 passed / 1604** (baseline 1558; +46) |
| `npm run build` | pass |
| `npm run migrations:check` | pass (pre-existing non-standard filenames only) |
| `npx tsx scripts/i18n-check-keys.ts` | pass |
| Production SQL executed | **No** |

---

## 6. Deployment order

1. Run `04_*` and `05_*` (SELECT-only) against Production to record current state.
2. Deploy this branch to **Preview**.
3. Sign in as Kunvar Thakor and confirm the expectations in §7.
4. Apply `20260731090000_…sql` via `06_*` SECTION A, then `NOTIFY pgrst, 'reload schema'`.
5. Create only the indexes `05_*` reported as missing.

Until step 4 the client stays on the legacy paged fallback, which is still
correct — just scoped to assigned + previously-actioned rows.

## 7. Expected Preview behaviour

- `count_reviewer_visible_expenses` returns the authorized total (~6,088 for Kunvar).
- `list_reviewer_visible_expenses_page` requests `p_page_size = 250`.
- First 250 core rows paint before any `expense_form_field_values` request fires.
- No response carries `Content-Range: 0-999/*`.
- Custom-field requests initially cover only the visible 25 rows.
- "Load All" shows `loaded N of TOTAL` and advances page by page.
