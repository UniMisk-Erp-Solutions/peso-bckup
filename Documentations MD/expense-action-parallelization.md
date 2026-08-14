# Expense Action Parallelization + Manager Review Performance

**Doc ID:** DOC-042  
**Last updated:** 2026-07-07  
**Status:** complete (SQL indexes need manual run in Supabase)

---

## Summary

Two performance improvements:

1. **`ExpenseService.ts`** — `approveExpense`, `rejectExpense`, `verifyExpense` had sequential `await` chains for independent operations. Converted to `Promise.all`.
2. **Manager review page (8–20s load)** — `fetchExecutiveHandoffExpenseIds` looped through audit_log chunks sequentially. Converted to `Promise.all`. Five DB indexes added to cover the most expensive queries.

---

## Problem

### ExpenseService sequential awaits

`approveExpense` ran 4 independent role checks one after another (~800ms each = 3.2s overhead before any action). Similarly for `rejectExpense` and `verifyExpense`.

### Manager review slow (8–20s)

`fetchExecutiveHandoffExpenseIds` chunked expense IDs (max 200 per `IN` clause) and looped with `for...of + await`. With 300+ expenses, that was 2 sequential DB round-trips = 4–6 seconds just for this function.

The manager review page also triggered unindexed table scans on `audit_logs`, `expenses`, and `organization_memberships`.

---

## Solution

### 1. Parallel role checks (ExpenseService.ts)

Before:
```typescript
const isAdmin = await checkRole(userId, "admin");
const isManager = await checkRole(userId, "manager");
const isEngineer = await checkRole(userId, "engineer");
const isExecutive = await checkRole(userId, "executive");
```

After:
```typescript
const [isAdmin, isManager, isEngineer, isExecutive] = await Promise.all([
  checkRole(userId, "admin"),
  checkRole(userId, "manager"),
  checkRole(userId, "engineer"),
  checkRole(userId, "executive"),
]);
```

Same pattern applied to post-RPC parallel work (logAction + profile fetch + notification).

### 2. Parallel chunk processing (managerActionableExpenses.ts)

Before:
```typescript
for (const batch of chunkArray(expenseIds)) {
  const { data } = await supabase.from("audit_logs")...
  // process data
}
```

After:
```typescript
const batchResults = await Promise.all(
  chunkArray(expenseIds).map(async (batch) => {
    const { data } = await supabase.from("audit_logs")...
    return data ?? [];
  }),
);
```

### 3. DB indexes

Migration: `supabase/migrations/290706_2100_manager_review_indexes.sql`

```sql
-- audit_logs: covers fetchExecutiveHandoffExpenseIds
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action_expense
  ON public.audit_logs(organization_id, action, expense_id)
  INCLUDE (comment);

-- expenses: covers status-filtered list queries
CREATE INDEX IF NOT EXISTS idx_expenses_org_status_updated
  ON public.expenses(organization_id, status, updated_at DESC);

-- expenses: covers assigned_engineer_id filter
CREATE INDEX IF NOT EXISTS idx_expenses_org_assigned_engineer
  ON public.expenses(organization_id, assigned_engineer_id, updated_at DESC)
  WHERE assigned_engineer_id IS NOT NULL;

-- expenses: covers assigned_reviewer_id filter
CREATE INDEX IF NOT EXISTS idx_expenses_org_assigned_reviewer
  ON public.expenses(organization_id, assigned_reviewer_id, updated_at DESC)
  WHERE assigned_reviewer_id IS NOT NULL;

-- organization_memberships: covers role-check EXISTS in every RPC
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_org_role_active
  ON public.organization_memberships(user_id, organization_id, role)
  WHERE is_active = true;
```

**User must run this migration manually in the Supabase SQL editor (project `avrbgpmzabktqwyzqibq`).**

---

## Key files

```
src/services/ExpenseService.ts              — approveExpense, rejectExpense, verifyExpense
src/lib/managerActionableExpenses.ts        — fetchExecutiveHandoffExpenseIds
supabase/migrations/290706_2100_manager_review_indexes.sql  — indexes (MUST RUN)
```

---

## Revision log

| Date | Rev | Notes |
|------|-----|-------|
| 2026-07-07 | 1.0 | Initial — ExpenseService parallelization + manager review fix |
