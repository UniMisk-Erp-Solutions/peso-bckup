# DOC-065 — Review Visibility Fix: Recursive Hierarchy Traversal

**Status:** applied (2026-07-16)  
**Branch:** `feature/user-activity-insights`  
**Date:** 2026-07-16

---

## 1. Problem

Employees appear under Executives/Managers in My Teams and User Management, but their expenses do **not** appear in Review Expenses for those managers/executives.

---

## 2. Root Causes

### Root Cause A — Single-level subordinate lookup

`fetchManagerSubordinateUserIds` in [`src/lib/managerReviewExpenses.ts`](../src/lib/managerReviewExpenses.ts) queried:

```sql
SELECT user_id FROM profiles
WHERE organization_id = :org_id
  AND reporting_engineer_id = :managerUserId
```

This is **one level deep** — direct reports only. In a `Manager → Executive → Team Leader → Employee` chain, the Manager can see their direct executives but cannot see TL or employee descendants.

### Root Cause B — View-only rows silently discarded

`fetchManagerReviewerExpenses` (line 347) applied this filter after fetching all rows:

```typescript
rows = rows.filter((row) => isRowInManagerReviewQueue(row, executiveHandoffIds, params));
```

`isRowInManagerReviewQueue` returns `false` for expenses that are visible to the manager but not yet at their action tier (e.g., a `submitted` expense being reviewed by a Team Leader before the executive acts). These rows were **removed from the result set**, so the manager couldn't see subordinate expenses at earlier stages of the approval chain.

**Visibility** (can see the expense) was conflated with **actionability** (has action buttons). They must be separate.

---

## 3. Fixes Applied

### Fix A — BFS recursive traversal in `fetchManagerSubordinateUserIds`

```typescript
// Before: single query, direct reports only
.eq("reporting_engineer_id", params.managerUserId)

// After: BFS traversal — finds all descendants (max 4 DB round-trips)
let frontier = [params.managerUserId];
while (frontier.length > 0) {
  const { data } = await supabase.from("profiles")
    .select("user_id")
    .eq("organization_id", params.organizationId)
    .in("reporting_engineer_id", frontier);
  // add new descendants to frontier...
}
```

The traversal follows the full `Manager → Executive → Team Leader → Employee` chain. Maximum practical depth is 4. Cycle guard prevents infinite loops if `reporting_engineer_id` is self-referential.

### Fix B — Remove the view-only filter, keep `manager_queue_ready` flag

```typescript
// Before (wrong): discards view-only rows
rows = rows.filter((row) => isRowInManagerReviewQueue(row, executiveHandoffIds, params));

// After (correct): keep all visible rows; actionability is a flag on each row
// manager_queue_ready is already added to every row below — use it in the UI
```

Every row still gets `manager_queue_ready: true/false` stamped on it. The UI uses this flag to decide whether to show action buttons (Verify / Approve / Reject) or just display the row in read-only mode.

---

## 4. Visibility vs. Actionability Model

| Condition | Visible? | `manager_queue_ready` | Explanation |
|-----------|---------|----------------------|-------------|
| Expense is assigned to manager as reviewer | Yes | `true` | Manager's direct action tier |
| Expense is in manager's reporting hierarchy but at a lower tier | Yes | `false` | View-only; subordinate is still acting |
| Expense is completed (approved/verified/rejected) | Yes | `true` | History; manager already acted |
| Expense is from a different org hierarchy | No | — | Never fetched |

---

## 5. Files Changed

| File | Change |
|------|--------|
| [`src/lib/managerReviewExpenses.ts`](../src/lib/managerReviewExpenses.ts) | BFS traversal in `fetchManagerSubordinateUserIds`; removed view-only filter |
| [`docs/sql/review-visibility/01_review_visibility_diagnostics.sql`](../docs/sql/review-visibility/01_review_visibility_diagnostics.sql) | Six SELECT-only diagnostic queries (read-only, do not execute in prod without read-only connection) |

---

## 6. Diagnostic SQL

See [`docs/sql/review-visibility/01_review_visibility_diagnostics.sql`](../docs/sql/review-visibility/01_review_visibility_diagnostics.sql) for:

1. Full recursive reporting chain (CTE)
2. Formal team membership path
3. All expenses visible via hierarchy
4. Expenses at manager's actionable tier
5. Gap analysis: hierarchy vs. RPC
6. Summary counts per status

Replace `:org_id` and `:manager_id` placeholders before running. Use a **read-only** DB connection.

---

## 7. No SQL Migrations Required

The fix is client-side. The existing `profiles.reporting_engineer_id` column and `organization_memberships.role` column are already present. The recursive BFS traversal happens in JavaScript, not in a new SQL function.

If the `list_manager_reviewer_expenses` RPC is later updated to perform the recursive traversal in SQL (for performance at large org sizes), that would be a separate migration — diagnostic SQL for that is in the `docs/sql/` file above.
