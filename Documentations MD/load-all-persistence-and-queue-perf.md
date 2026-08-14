# Load-All Persistence + Manager Queue Performance

**Doc ID:** DOC-050
**Status:** complete
**Last updated:** 2026-07-13
**Owner / area:** EngineerReview, AdminPanel, Manager Review Queue

---

## 1) Summary

Three interrelated improvements to the manager/admin expense review flow:

1. **Load-all persistence** — once a reviewer presses "Load All Expenses", the full-load
   mode survives navigation within the same browser tab. Previously `useState(false)` reset
   on every component unmount, forcing the user to press "Load All" again on every page visit.

2. **Admin panel page restoration** — navigating away from the Admin All Expenses view and
   returning now restores the previous pagination page. Previously page always reset to 1.

3. **Manager review queue speed** — the `fetchManagerReviewerExpenses` fetch path was making
   3–4 sequential HTTP round-trip "rounds". Collapsed to 2 rounds by parallelising all
   independent queries. Additionally, `fetchExecutiveHandoffExpenseIds` was issuing 10–15
   parallel `audit_logs` chunk queries (3–5 s each); replaced with one org-scoped query
   filtered in JS. The `level_2_verified` fallback is now gated so it only fires when the
   executive approval tier is enabled (prevents 57014 statement timeout on orgs without that
   tier).

---

## 2) Problem / requirement

### Load-all resets on navigation (user report)
After pressing "Load All Expenses" (showing all 400+ expenses), the user navigated to review
an expense and pressed back. The component re-mounted, `useState(false)` ran again, and the
next data fetch used the initial 300-row limit — losing the load-all state. The user had to
press "Load All" again each time.

### Page position lost on back (user report)
After reviewing expense #125 on page 5 of the Admin All Expenses table, pressing "back"
returned to page 1 (component re-mounted, no saved state).

### Loading took 40–60 seconds (user report + network trace)
Network trace showed:
- 12+ parallel `audit_logs` queries for `fetchExecutiveHandoffExpenseIds`, each 3–5 s
  (chunk size 100 × 300+ expense IDs = 3+ chunks; browser HTTP/1.1 limit of 6 connections
  caused 2 sequential rounds of 6 queries).
- `level_2_verified` fallback: `status=eq.level_2_verified` on the full `expenses` table
  with no limit → Postgres 57014 statement timeout (8 s wasted, then caught and ignored).
- Manager fetch had 3 sequential `await Promise.all` rounds before enrichment.

---

## 3) Solution

### 3a — Load-all persistence (sessionStorage)

Two sessionStorage keys written on successful load-all, read on component mount via lazy
`useState` initialiser, cleared on signOut:

| Key | Page |
|-----|------|
| `pesowise:load-all:admin` | AdminPanel All Expenses |
| `pesowise:load-all:review` | EngineerReview / Review Queue |

Because `useState(() => sessionStorage.getItem(...) === "true")` runs synchronously before the
first `useEffect`, the restored value is used for the initial data fetch — no extra round trip.

### 3b — Admin panel page restoration (sessionStorage + filterMountedRef)

Key: `pesowise:admin-expenses-page`

A `filterMountedRef = useRef(false)` skips the first firing of the filter-reset `useEffect`
(which previously called `setCurrentPage(1)` on mount, overwriting the restored value):

```ts
useEffect(() => {
  if (!filterMountedRef.current) { filterMountedRef.current = true; return; }
  setCurrentPage(1);
}, [searchTerm, statusFilter, expenseSortBy, expenseSortOrder, customFieldFilters]);
```

A separate effect saves the current page on every change:
```ts
useEffect(() => {
  sessionStorage.setItem("pesowise:admin-expenses-page", String(currentPage));
}, [currentPage]);
```

All three keys are cleared in `AuthContext.signOut()`.

EngineerReview already had a correct `pageRestoredRef` pattern — no changes needed there.

### 3c — Manager fetch round collapse

**Before (3 sequential rounds in `fetchManagerReviewerExpenses`):**
1. `await Promise.all([pendingRpc, reviewerRpc])`
2. `await Promise.all([subordinateIds, teamMemberIds])`
3. `await Promise.all([assigned_engineer, assigned_reviewer, subordinate batches, team batches, level_2_verified])`

**After (2 rounds):**
- Round 1: RPCs + subordinate ID fetch + team member ID fetch + `assigned_engineer` query +
  `assigned_reviewer` query + `level_2_verified` query (all independent — fire in parallel)
- Round 2: subordinate batch queries + team member batch queries (depend on IDs from Round 1)

Saves one full HTTP round-trip = approximately 5–15 s on slow connections.

### 3d — fetchExecutiveHandoffExpenseIds single-query

**Before:** chunk expense IDs into groups of 100, issue one `audit_logs` query per chunk in
`Promise.all`. With 1200 expense IDs = 12 queries × 3–5 s each (throttled by browser HTTP/1.1
connection limit).

**After:** one query fetching all `tier_advanced` audit logs for the org
(`WHERE organization_id = ? AND action = 'tier_advanced'`), then filter by expense ID set in
JavaScript. `tier_advanced` is a rare action; the result set is small regardless of the number
of expenses.

### 3e — level_2_verified fallback gated

The fallback `query.eq("status", "level_2_verified")` with no row limit caused a Postgres
statement timeout (57014) when the `expenses` table is large. The `level_2_verified` status
only exists in the executive-tier approval workflow, so the query is wrapped:

```ts
params.executiveTierEnabled
  ? tryFetchExpensesByFilter(...)  // level_2_verified scan
  : Promise.resolve([])
```

---

## 4) Key files

```
src/pages/AdminPanel.tsx
  - filterMountedRef added (line ~205)
  - currentPage: useState lazy-init from sessionStorage (line ~211)
  - filter-reset useEffect: skips first run (line ~1304)
  - sessionStorage save useEffect (line ~1312)

src/pages/EngineerReview.tsx
  - allExpensesLoaded: lazy-init from "pesowise:load-all:review" (line ~225)
  - handleLoadAllExpenses: writes sessionStorage key after successful load

src/contexts/AuthContext.tsx
  - signOut: clears pesowise:load-all:admin, pesowise:load-all:review,
    pesowise:admin-expenses-page (line ~603)

src/lib/managerReviewExpenses.ts
  - fetchManagerReviewerExpenses: 3 rounds collapsed to 2 (line ~218)
  - level_2_verified gated behind params.executiveTierEnabled (line ~252)

src/lib/managerActionableExpenses.ts
  - fetchExecutiveHandoffExpenseIds: chunked IN queries → single org-scoped query (line ~5)
  - removed unused chunkArray import
```

---

## 5) Database / migrations

No migrations. All changes are frontend JavaScript/TypeScript.

The `level_2_verified` 500 (statement timeout) on orgs with `executiveTierEnabled = true` can
be fully fixed by adding a DB index:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_expenses_org_status_updated
  ON public.expenses (organization_id, status, updated_at DESC);
```

Apply manually via Supabase SQL Editor. This is a safe `IF NOT EXISTS` index; no downtime.

---

## 6) Test plan

- [ ] As a manager/engineer with 400+ expenses in queue, press "Load All" on Review Queue
  → all expenses load; navigate to a different page and back → still in load-all mode, no
  "Load All" button needed.
- [ ] Same for Admin All Expenses with "pesowise:load-all:admin".
- [ ] On Admin All Expenses, scroll to page 8, navigate away, come back → page 8 restored.
- [ ] Filter change (e.g. change status filter) → page resets to 1 (filterMountedRef doesn't
  block this, only the initial mount).
- [ ] Sign out → sessionStorage keys cleared; next login starts fresh (no stale page/load-all).
- [ ] Network tab: `audit_logs` shows exactly ONE `tier_advanced` query per load (was 10–15).
- [ ] Network tab: no 500 on `level_2_verified` query for orgs with executive tier disabled.
- [ ] 728/728 tests still pass.

---

## 7) Related docs

- [DOC-042 — Expense Action Parallelization](./expense-action-parallelization.md)
- [DOC-043 — Batch Review UX — State Persistence](./batch-review-ux-july2026.md)
- [DOC-048 — Team Reports Verification Timeout Fix](./team-reports-verification-timeout-fix.md)
- [DOC-049 — Expense Performance Safe Pass](./expense-performance-safe-pass.md)

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-07-13 | 1.0 | Agent | Initial — load-all persistence, admin page restore, 3→2 fetch rounds, single audit_log query, level_2_verified gate. 728 tests pass. |
