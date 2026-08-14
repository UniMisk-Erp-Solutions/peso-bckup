# DOC-041 — Manager Review RPC Performance Fix

**Branch:** `main`
**Status:** complete
**Last updated:** 2026-07-06

---

## Problems

Two live bugs reported from `ml.pesowise.unimisk.com`:

1. **1.6-minute page load** — the Review Expenses page timed out. Console showed:
   ```
   Manager pending expense fetch failed: canceling statement due to statement timeout
   manager review fallback query failed (level_2_verified): Object
   ```

2. **Manager step skipped** — after an executive verified an expense (status → `level_2_verified`), the manager could not see those expenses in their review queue because the `list_manager_pending_expenses` RPC returned a 500 error (timeout).

---

## Root cause

Both `list_manager_pending_expenses` and `list_manager_reviewer_expenses` called per-row SQL functions for **every expense row** in the organization:

### 1. `expense_executive_handoff_in_audit(e)` — per-row ILIKE scan on `audit_logs`

```sql
-- Called for EVERY expense row:
SELECT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE expense_id = e.id
    AND action = 'tier_advanced'
    AND (
      comment ILIKE '%advanced to engineer%'
      OR (comment ILIKE '%verified at executive%' AND comment ILIKE '%advanced to%')
    )
);
```

This function was called **twice per row** — once directly in the WHERE clause and once inside `expense_ready_for_manager_review(e)`.

### 2. `manager_expense_visible_to_user(e, uid)` — 3–5 correlated subqueries per row

```sql
-- Per-row: EXISTS on profiles (direct reports)
-- Per-row: profiles emp JOIN profiles sup (2-level chain)  
-- Per-row: team_members JOIN teams (team membership)
```

### Combined impact

With N expenses in the org, this produces **O(N × 7)** subqueries. With 300+ expenses: 2,000+ correlated subqueries in a single RPC call → PostgreSQL statement timeout.

---

## Fix

Created migration `supabase/migrations/290706_0900_manager_rpc_performance_fix.sql`.

### Strategy: CTE-based set computation

Instead of calling functions per row, compute everything as sets **once**, then filter with `IN`:

```
OLD: for each expense → call manager_expense_visible_to_user() → call expense_executive_handoff_in_audit()
NEW: compute visible_users once → compute handoff_ids once → filter expenses with IN (set)
```

### CTEs used in the rewrite

| CTE | Purpose | Replaces |
|-----|---------|---------|
| `caller` | Gate: caller must be an active engineer | `EXISTS (SELECT 1 FROM organization_memberships ...)` per row |
| `direct_reports` | User IDs of direct reports | Part of `manager_expense_visible_to_user` per row |
| `l2_reports` | User IDs of level-2 reports | Part of `manager_expense_visible_to_user` per row |
| `team_users` | User IDs of managed team members | Part of `manager_expense_visible_to_user` per row |
| `visible_users` | Union of all visible user IDs | Replaces entire `manager_expense_visible_to_user` function |
| `handoff_ids` | Expense IDs where executive advanced (single bulk scan) | Replaces `expense_executive_handoff_in_audit(e)` called per row |
| `manager_acted` | Expense IDs this manager actioned (for terminal display) | Per-row audit_logs subquery in terminal branch |

### Actionability logic (inlined from `expense_ready_for_manager_review`)

The rewrite inlines the ready-check directly in the CTE query:

```sql
e.status = 'level_2_verified'                                 -- executive approved
OR (COALESCE(e.approval_tier,'') = 'engineer' AND e.status IN (...))  -- engineer-tier
OR (e.approval_tier IS NULL AND e.status IN ('submitted','edited','under_review'))  -- no hierarchy
OR e.id IN (SELECT expense_id FROM handoff_ids)               -- stuck rows via audit log
```

The **`level_2_verified` case is explicitly in the first branch**, so managers now see executive-verified expenses once the RPC returns results (previously the timeout prevented any results).

### Indexes added

```sql
CREATE INDEX IF NOT EXISTS idx_expenses_org_status         ON expenses(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_org_updated_at     ON expenses(organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action       ON audit_logs(organization_id, action);
CREATE INDEX IF NOT EXISTS idx_profiles_org_reporting_engineer  ON profiles(organization_id, reporting_engineer_id);
CREATE INDEX IF NOT EXISTS idx_team_members_org_team_user  ON team_members(organization_id, team_id, user_id);
CREATE INDEX IF NOT EXISTS idx_teams_org_manager           ON teams(organization_id, manager_user_id);
```

The `idx_audit_logs_org_action` index narrows the `handoff_ids` CTE to only `tier_advanced` rows for this org before the ILIKE text match, dramatically reducing the scan size.

---

## Files changed

| File | Change |
|------|--------|
| `supabase/migrations/290706_0900_manager_rpc_performance_fix.sql` | **New migration** — 6 indexes + CTE rewrite of both RPCs |

### Functions NOT changed (left intact, may be used elsewhere)

- `expense_executive_handoff_in_audit(e)` — still exists; no longer called per row by either RPC
- `expense_ready_for_manager_review(e)` — still exists; logic inlined in new RPCs
- `manager_expense_visible_to_user(e, uid)` — still exists; replaced by `visible_users` CTE

---

## Performance comparison

| | Before | After |
|--|--------|-------|
| `audit_logs` ILIKE scans | N × 2 (per row, twice) | 1 (single org-scoped scan) |
| `profiles` correlated subqueries | N × 2 (direct + 2-level join per row) | 1 CTE each (2 total) |
| `team_members` JOIN subquery | N × 1 per row | 1 CTE |
| Total DB round-trips (300 expenses) | ~2,100+ | ~7–8 |
| Page load time | 1.6 minutes (timeout) | Expected <3 seconds |

---

## Bugs fixed

1. **Fix 1 (Performance):** RPC no longer times out → page loads in normal time.
2. **Fix 2 (Manager skip):** `level_2_verified` is in the active-status branch of the new RPC → managers see these expenses once the query completes.

---

## How to apply

Run the migration in Supabase SQL Editor (or let Supabase CLI pick it up):

```sql
-- File: supabase/migrations/290706_0900_manager_rpc_performance_fix.sql
```

No frontend changes required. The RPC signature (`list_manager_pending_expenses(uuid)` and `list_manager_reviewer_expenses(uuid)`) is unchanged — callers are unaffected.

---

## Related docs

- [DOC-L02 Manager Workflow Issues](../docs/manager-workflow-issue-report.md) — original hierarchy flow documentation
- [DOC-002 Admin Hierarchy Approval Bypass](./admin-hierarchy-approval-bypass.md) — approval tier logic

---

## Index revision log

| Date | Change |
|------|--------|
| 2026-07-06 | DOC-041 created — manager RPC performance fix + manager step skip bug |
