-- Performance indexes for review_approve_expense and review_verify_expense RPCs.
-- These RPCs do EXISTS subqueries on organization_memberships (2×) and
-- organization_features (1×) per call. Without these indexes Postgres does
-- a sequential scan over all active members of the org on every approval.

-- Covers the double role-check EXISTS in every approve/verify RPC
-- (user_id, organization_id, role WHERE is_active = true)
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_org_role_active
  ON public.organization_memberships(user_id, organization_id, role)
  WHERE is_active = true;

-- Covers the hierarchy feature-flag lookup in every approve RPC
CREATE INDEX IF NOT EXISTS idx_org_features_org_key
  ON public.organization_features(organization_id, feature_key);

-- Covers the assigned-reviewer EXISTS check per expense
CREATE INDEX IF NOT EXISTS idx_expenses_assigned_reviewer
  ON public.expenses(assigned_reviewer_id, organization_id)
  WHERE assigned_reviewer_id IS NOT NULL;

-- Covers the assigned-engineer EXISTS check per expense
CREATE INDEX IF NOT EXISTS idx_expenses_assigned_engineer
  ON public.expenses(assigned_engineer_id, organization_id)
  WHERE assigned_engineer_id IS NOT NULL;
