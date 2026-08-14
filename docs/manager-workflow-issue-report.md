# PesoWise Manager Workflow Issue Report

## 1) What the app is about

PesoWise is an expense workflow platform where employees submit expenses and designated reviewers process them through a multi-step approval chain.  
In your hierarchy-enabled setup, the expected path is:

1. Employee submits expense  
2. Team Leader verifies (Level 1)  
3. Executive verifies (Level 2)  
4. Manager reviews:
   - If amount is within manager approval limit: manager can approve  
   - If amount exceeds manager approval limit: manager verifies (Level 3 verified state), then admin final approval

The app also includes:
- reviewer/admin panels
- audit logs and timeline
- notifications
- PDF/attachment preview
- organization-level approval limit settings

---

## 2) Main issue you reported

Even after Team Leader + Executive steps, manager cannot consistently see or act on those expenses in the manager review page.

Observed symptoms from logs/screens:
- missing Level 1/Level 2 verified rows in manager list
- occasional "You are not assigned to approve this expense"
- fallback/RPC failures and schema-cache errors
- intermittent fetch failures causing empty manager table

---

## 3) Root-cause patterns identified

### A) Missing or partially applied DB migration/RPC state

Your logs showed:
- missing function errors for `repair_expense_for_manager_review` (earlier)
- then permission errors on that same RPC in some states

This indicates DB functions/policies/data state are not fully consistent across all rows and org setup.

### B) Stale assignment metadata after hierarchy handoff

Some expenses appear to advance logically (TL -> Executive), but assignment fields (`assigned_reviewer_id`, `assigned_engineer_id`, `approval_tier`) are not always aligned in a way that manager list queries can reliably detect.

### C) Query brittleness caused full list failures

A newly added fallback query using `approved_by` produced a 400 in your environment.  
That one failing branch caused full list load errors until made non-blocking.

---

## 4) What has been changed so far (code-side)

### Timeline and workflow display fixes
- Corrected manager-stage assignee text in timeline.
- Added dynamic manager-stage label to reflect over-limit path (`Level 3 verified (Manager)`).

### Manager approval and permission fixes
- Allowed manager approval of `level_2_verified` in hierarchy mode.
- Improved permission fallbacks when RPC helper is missing/stale.
- Added legacy profile fallback path for manager lookup.

### Manager list fetch hardening
- Added multiple fallback sources (RPC + assignment + team/subordinate + hierarchy-stage fallback).
- Made fallback queries non-blocking so one bad query does not blank the table.

### Approved visibility improvements
- Approve action now writes `approved_by` and `approved_at` (with rollback cleanup).
- Added approved-row fallback retrieval logic (including audit-log based fallback).

---

## 5) Why issue may still persist

The remaining problem is likely not frontend rendering.  
It is likely one or more of:

1. **DB migration gap** (functions exist in codebase but not fully deployed/reloaded in project)
2. **RLS visibility mismatch** for manager on hierarchy-stage rows
3. **Data-level inconsistency** in existing expenses created before/around migration changes
4. **Permission function behavior** (`expense_manager_can_review`, `manager_expense_visible_to_user`, etc.) not matching expected org/team setup for specific rows

---

## 6) Immediate DB checks to run (SQL Editor)

Run these in Supabase SQL Editor on the target project:

```sql
-- 1) Check if key functions exist
select proname
from pg_proc
where proname in (
  'list_manager_pending_expenses',
  'list_manager_level2_expenses',
  'list_manager_reviewer_expenses',
  'repair_expense_for_manager_review',
  'review_verify_expense',
  'expense_manager_can_review',
  'manager_expense_visible_to_user'
)
order by proname;
```

```sql
-- 2) Check current problematic rows (replace org id)
select id, status, approval_tier, user_id, assigned_reviewer_id, assigned_engineer_id, updated_at
from expenses
where organization_id = 'YOUR_ORG_ID'
  and status in ('level_1_verified', 'level_2_verified', 'submitted', 'edited')
order by updated_at desc
limit 200;
```

```sql
-- 3) Check team mapping for manager visibility (replace manager id)
select t.id as team_id, t.manager_user_id, tm.user_id as member_user_id
from teams t
left join team_members tm on tm.team_id = t.id and tm.organization_id = t.organization_id
where t.organization_id = 'YOUR_ORG_ID'
  and t.manager_user_id = 'MANAGER_USER_ID';
```

```sql
-- 4) Spot rows likely "stuck" for manager visibility
select e.id, e.status, e.approval_tier, e.assigned_reviewer_id, e.assigned_engineer_id
from expenses e
where e.organization_id = 'YOUR_ORG_ID'
  and (
    e.status in ('level_1_verified', 'level_2_verified')
    or (e.approval_tier = 'engineer' and e.status in ('submitted','edited','level_1_verified'))
  )
order by e.updated_at desc;
```

---

## 7) Recommended next action plan

1. Confirm all required hierarchy/manager RPCs exist in DB.
2. Re-run missing migrations in order and refresh API schema cache.
3. Validate one known expense ID end-to-end:
   - status
   - tier
   - assignees
   - team relation between employee and manager
4. If function exists but visibility still fails, patch DB helper logic (`expense_manager_can_review` / `manager_expense_visible_to_user`) for your exact org model.
5. Backfill stale existing rows with a targeted repair query.

---

## 8) Notes on noisy console errors

Many console lines you shared are not the core workflow bug:
- browser extension injection (`content.js`, Grammarly errors)
- PWA manifest warnings on `blob:` URLs
- transient realtime reconnect/subscription CLOSED/SUBSCRIBED churn

These are mostly environmental noise.  
The critical signal was fetch/RPC/permission behavior around manager hierarchy rows.

---

## 9) Current status summary

- Multiple frontend/service fixes are already applied to increase resilience.
- The issue now appears primarily DB-state/RLS/function-consistency related for specific hierarchy rows.
- Next reliable resolution is DB verification + targeted policy/function/row repair.

