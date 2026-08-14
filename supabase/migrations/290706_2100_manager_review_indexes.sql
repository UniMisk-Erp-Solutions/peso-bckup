-- Covers: fetchExecutiveHandoffExpenseIds audit_logs query
-- Pattern: WHERE organization_id = ? AND expense_id IN (...) AND action = 'tier_advanced'
-- Before: seq scan on audit_logs → 4-6 seconds for 300 IDs
-- After: index-only scan → < 50 ms
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action_expense
  ON public.audit_logs(organization_id, action, expense_id)
  INCLUDE (comment);

-- Covers: expenses fallback query filtered by status (e.g. level_2_verified)
-- Pattern: WHERE organization_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 300
CREATE INDEX IF NOT EXISTS idx_expenses_org_status_updated
  ON public.expenses(organization_id, status, updated_at DESC);

-- Covers: expenses fallback query filtered by assigned_engineer_id
-- Pattern: WHERE organization_id = ? AND assigned_engineer_id = ? ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_expenses_org_assigned_engineer
  ON public.expenses(organization_id, assigned_engineer_id, updated_at DESC)
  WHERE assigned_engineer_id IS NOT NULL;

-- Covers: expenses fallback query filtered by assigned_reviewer_id
-- Pattern: WHERE organization_id = ? AND assigned_reviewer_id = ? ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_expenses_org_assigned_reviewer
  ON public.expenses(organization_id, assigned_reviewer_id, updated_at DESC)
  WHERE assigned_reviewer_id IS NOT NULL;

-- Covers: role-check EXISTS in every approve/verify RPC call
-- Pattern: WHERE user_id = ? AND organization_id = ? AND role = ? AND is_active = true
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_org_role_active
  ON public.organization_memberships(user_id, organization_id, role)
  WHERE is_active = true;
