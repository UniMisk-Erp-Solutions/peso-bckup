# Expense Performance — Safe Optimisation Pass

**Doc ID:** DOC-049  
**Status:** complete  
**Last updated:** 2026-07-09  
**Owner / area:** AdminPanel, ExpenseForm, EngineerReview, DB indexes

---

## 1) Summary

Three targeted, low-risk performance improvements applied without touching any business logic, RLS policies, approval flows, or existing fetch architecture.

| # | Change | File | Risk |
|---|--------|------|------|
| 1 | Replace `profiles.find()` O(n²) with Map lookup | `AdminPanel.tsx` | None — same output, faster |
| 2 | Make analytics fire-and-forget (non-blocking) | `ExpenseForm.tsx` | None — analytics already non-critical |
| 3 | Cache employee IDs in ref, stop re-fetching on every realtime event | `EngineerReview.tsx` | None — IDs only change when org structure changes |

SQL index files created in `docs/sql/expense-performance/` for future manual application.

---

## 2) Change 1 — AdminPanel: O(n²) profile lookup → Map

### Problem

`mapExpensesWithProfiles` is called to merge expense rows with profile data. Inside the `.map()` loop it called `profiles?.find(p => p.user_id === expense.user_id)` — a linear scan through all profiles for every expense. With N profiles and M expenses this is O(N × M).

At scale (e.g. 500 profiles, 1000 expenses) this produces 500,000 comparisons on every render cycle that triggers the function.

### Fix

Build a `Map<string, profile>` once before the loop, then replace `find` with `get`:

```typescript
// Before (O(n²))
const profile = profiles?.find((p) => p.user_id === expense.user_id);

// After (O(1) per lookup)
const profileMap = new Map((profiles ?? []).map((p) => [p.user_id, p]));
// ...inside .map():
const profile = profileMap.get(expense.user_id as string);
```

**File:** `src/pages/AdminPanel.tsx` — `mapExpensesWithProfiles` function (around line 645).

---

## 3) Change 2 — ExpenseForm: analytics fire-and-forget

### Problem

`trackFormFieldSelections` and `trackBaseFieldSelections` were called with `await` inside the expense save flow. Even though they were wrapped in a `try/catch` with a `console.warn` on failure, the `await` still blocked the save from completing until both analytics calls resolved. On slow connections this added latency visible to the user.

The comment already said "Best-effort analytics; must never fail the save" — the `await` contradicted that intent.

### Fix

Wrap the entire analytics block in a fire-and-forget `void (async () => { ... })()`:

```typescript
// Before — save blocked by analytics
await trackFormFieldSelections(...);
await trackBaseFieldSelections(...);

// After — save completes immediately, analytics run in background
void (async () => {
  try {
    await trackFormFieldSelections(...);
    await trackBaseFieldSelections(...);
  } catch (trackErr) {
    console.warn("trackFormFieldSelections failed (non-fatal):", trackErr);
  }
})();
```

**File:** `src/pages/ExpenseForm.tsx` — inside `saveFormFields` (around line 1339).

---

## 4) Change 3 — EngineerReview: cache employee IDs in ref

### Problem

`getEmployeeIds()` — a Supabase query fetching all `profiles` where `reporting_engineer_id = user.id` — was called on **every** realtime INSERT and UPDATE event on the `expenses` table.

For a reviewer with 20 direct reports receiving a burst of 10 realtime events, this fired 20 extra Supabase round-trips in rapid succession, all returning identical data.

### Fix

- Rename `getEmployeeIds` → `loadEmployeeIds` (signals it writes to a ref, not returns a value)
- Store result in `employeeIdsRef.current` (a `useRef<string[]>([])`)
- Call `loadEmployeeIds()` once on mount
- Remove `await getEmployeeIds()` from both realtime handlers — handlers now read `employeeIdsRef.current` synchronously

```typescript
// Added ref
const employeeIdsRef = useRef<string[]>([]);

// Load once on mount
const loadEmployeeIds = async () => {
  const { data } = await supabase.from("profiles").select("user_id")
    .eq("reporting_engineer_id", user.id);
  employeeIdsRef.current = (data || []).map((p) => p.user_id);
};
void loadEmployeeIds();

// Realtime handler — no await, no DB call
(payload) => {
  const relevant = employeeIdsRef.current.includes(newExpense.user_id) || ...;
  if (relevant) scheduleBackgroundRefetch();
}
```

**Trade-off:** If a new employee is assigned to this reviewer after page load, the ref won't include them until the page refreshes. This is acceptable — hierarchy changes are infrequent admin actions and the reviewer's own `fetchAssignedExpenses` poll will still surface the new expense on the next background refetch.

**File:** `src/pages/EngineerReview.tsx` — realtime `useEffect` (around line 338).

---

## 5) SQL index files (manual application required)

Files in `docs/sql/expense-performance/`:

| File | Purpose |
|------|---------|
| `00_verify_existing_indexes.sql` | Check which indexes exist; confirm no in-progress build |
| `01_create_indexes_concurrently.sql` | Create 3 indexes with CONCURRENTLY (psql / non-Editor) |
| `01b_create_indexes_non_concurrent_fallback.sql` | Same, without CONCURRENTLY (Supabase SQL Editor) |
| `02_explain_current_expense_queries.sql` | EXPLAIN ANALYZE 4 hot query patterns |
| `03_counts_for_debug.sql` | Volume counts per status / user / day / batch |
| `99_rollback_indexes_DO_NOT_RUN.sql` | Drop the 3 indexes (rollback only) |

### Indexes being added

| Index | Columns | Benefit |
|-------|---------|---------|
| `idx_expenses_user_created` | `(user_id, created_at DESC)` | Engineer/Expenses page: user expense list |
| `idx_expenses_user_updated` | `(user_id, updated_at DESC)` | Realtime-triggered refetches |
| `idx_expenses_batch_org_created` | `(batch_id, organization_id, created_at DESC) WHERE batch_id IS NOT NULL` | Batch expansion queries |

**Note:** `idx_expenses_org_status_created` was already applied as part of DOC-048 (team-reports timeout fix). Do not re-create it.

---

## 6) What was NOT changed

- No RLS policies touched
- No approval/review logic touched
- No status transitions changed
- No existing fetch flows removed or rewritten
- No fallback logic removed
- AdminPanel, EngineerReview, ExpenseForm architecture unchanged

---

## Revision log

| Date | Revision | Notes |
|------|----------|-------|
| 2026-07-09 | 1.0 | Initial — three targeted safe optimisations + SQL index files |
