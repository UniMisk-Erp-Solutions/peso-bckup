-- When TL/executive tiers are disabled on an org, expenses stuck at those tiers
-- should still appear in the manager review queue.

CREATE OR REPLACE FUNCTION public.org_hierarchy_tier_enabled(
  p_organization_id uuid,
  p_tier text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_tier IS NULL OR p_tier IN ('engineer', 'admin') THEN true
    WHEN p_tier = 'team_leader' THEN
      EXISTS (
        SELECT 1
        FROM public.organization_features of_m
        WHERE of_m.organization_id = p_organization_id
          AND of_m.feature_key = 'approval_hierarchy'
          AND of_m.enabled = true
      )
      AND EXISTS (
        SELECT 1
        FROM public.organization_features of_tl
        WHERE of_tl.organization_id = p_organization_id
          AND of_tl.feature_key = 'hierarchy_team_leader'
          AND of_tl.enabled = true
      )
    WHEN p_tier = 'executive' THEN
      EXISTS (
        SELECT 1
        FROM public.organization_features of_m
        WHERE of_m.organization_id = p_organization_id
          AND of_m.feature_key = 'approval_hierarchy'
          AND of_m.enabled = true
      )
      AND EXISTS (
        SELECT 1
        FROM public.organization_features of_ex
        WHERE of_ex.organization_id = p_organization_id
          AND of_ex.feature_key = 'hierarchy_executive'
          AND of_ex.enabled = true
      )
    ELSE true
  END;
$$;

CREATE OR REPLACE FUNCTION public.expense_ready_for_manager_review(e public.expenses)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    e.status NOT IN ('verified', 'approved', 'rejected')
    AND (
      e.status = 'level_2_verified'::public.expense_status
      OR (
        COALESCE(e.approval_tier, '') = 'engineer'
        AND e.status IN (
          'submitted'::public.expense_status,
          'edited'::public.expense_status,
          'under_review'::public.expense_status,
          'level_1_verified'::public.expense_status,
          'level_2_verified'::public.expense_status
        )
      )
      OR (
        e.approval_tier IS NULL
        AND e.status IN (
          'submitted'::public.expense_status,
          'edited'::public.expense_status,
          'under_review'::public.expense_status
        )
      )
      OR (
        e.approval_tier IN ('team_leader', 'executive')
        AND e.status IN (
          'submitted'::public.expense_status,
          'edited'::public.expense_status,
          'under_review'::public.expense_status,
          'level_1_verified'::public.expense_status,
          'level_2_verified'::public.expense_status
        )
        AND NOT public.org_hierarchy_tier_enabled(e.organization_id, e.approval_tier)
      )
      OR (
        e.status IN (
          'submitted'::public.expense_status,
          'edited'::public.expense_status,
          'level_1_verified'::public.expense_status
        )
        AND public.expense_executive_handoff_in_audit(e)
      )
    );
$$;

REVOKE ALL ON FUNCTION public.org_hierarchy_tier_enabled(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_hierarchy_tier_enabled(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.expense_ready_for_manager_review(public.expenses) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_ready_for_manager_review(public.expenses) TO authenticated;
