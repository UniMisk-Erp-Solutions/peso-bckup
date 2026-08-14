-- Missing expenses indexes identified by query audit (59 direct table queries in codebase).
-- Existing indexes already cover: org+status+updated_at, org+assigned_engineer+updated_at,
-- org+assigned_reviewer+updated_at, org+approval_tier+status, batch_id (single col), id (PK).
--
-- Gaps filled here:

-- 1. Employee's own expense list — Expenses.tsx primary pagination
--    Pattern: WHERE user_id = ? ORDER BY updated_at DESC RANGE offset,end
--    Previously: idx_expenses_user_id only covered the filter, not the sort.
CREATE INDEX IF NOT EXISTS idx_expenses_user_updated
  ON public.expenses(user_id, updated_at DESC);

-- 2. Batch expense row fetches — BatchExpenseReviewPanel, ExpenseForm, ExpenseDetail
--    Pattern: WHERE batch_id = ? AND organization_id = ? ORDER BY created_at ASC
--    Previously: idx_expenses_batch_id (single col) had no org filter or sort.
CREATE INDEX IF NOT EXISTS idx_expenses_batch_org_created
  ON public.expenses(batch_id, organization_id, created_at ASC)
  WHERE batch_id IS NOT NULL;

-- 3. Accountant approved-expenses page
--    Pattern: WHERE organization_id = ? AND status = 'approved' ORDER BY created_at DESC
--    Previously: existing org+status+updated_at index had wrong sort column (updated_at vs created_at).
CREATE INDEX IF NOT EXISTS idx_expenses_org_status_created
  ON public.expenses(organization_id, status, created_at DESC);

-- 4. Analytics date-range queries per employee
--    Pattern: WHERE user_id = ? AND created_at >= ? AND created_at <= ?
--    Previously: idx_expenses_user_id (just user_id) — no created_at for range scan.
CREATE INDEX IF NOT EXISTS idx_expenses_user_created
  ON public.expenses(user_id, created_at DESC);
