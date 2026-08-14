-- Fix Level 2 Verified visibility for managers and backfill stuck pipeline rows.

CREATE OR REPLACE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.status IN (
      'submitted',
      'verified',
      'approved',
      'rejected',
      'edited',
      'under_review',
      'level_1_verified',
      'level_2_verified'
    )
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
    AND (
      e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
      OR (
        e.approval_tier = 'engineer'
        AND (
          e.assigned_reviewer_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
          AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = auth.uid()
      )
      OR (
        e.status = 'level_2_verified'
        AND EXISTS (
          SELECT 1
          FROM public.team_members tm
          JOIN public.teams t
            ON t.id = tm.team_id
            AND t.organization_id = tm.organization_id
          WHERE tm.user_id = e.user_id
            AND tm.organization_id = e.organization_id
            AND t.manager_user_id = auth.uid()
        )
      )
    );
$$;

-- Executive verified (or advanced to manager) but status never became level_2_verified.
UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
WHERE e.status = 'level_1_verified'::public.expense_status
  AND e.approval_tier = 'engineer';

UPDATE public.expenses e
SET
  status = 'level_2_verified'::public.expense_status,
  approval_tier = 'engineer',
  updated_at = now()
WHERE e.status = 'level_1_verified'::public.expense_status
  AND EXISTS (
    SELECT 1
    FROM public.audit_logs al
    WHERE al.expense_id = e.id
      AND al.action = 'tier_advanced'
      AND al.comment ILIKE '%executive%'
  );

-- Assign manager on level_2 rows for team members.
UPDATE public.expenses e
SET
  approval_tier = 'engineer',
  assigned_reviewer_id = t.manager_user_id,
  assigned_engineer_id = t.manager_user_id,
  updated_at = now()
FROM public.team_members tm
JOIN public.teams t
  ON t.id = tm.team_id
  AND t.organization_id = tm.organization_id
WHERE tm.user_id = e.user_id
  AND tm.organization_id = e.organization_id
  AND t.manager_user_id IS NOT NULL
  AND e.status = 'level_2_verified'::public.expense_status
  AND (
    e.assigned_reviewer_id IS DISTINCT FROM t.manager_user_id
    OR e.assigned_engineer_id IS DISTINCT FROM t.manager_user_id
    OR COALESCE(e.approval_tier, '') <> 'engineer'
  );
