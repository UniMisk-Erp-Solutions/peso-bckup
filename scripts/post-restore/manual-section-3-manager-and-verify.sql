-- =============================================================================
-- SECTION 3 of 3 — Run THIRD
-- Manager visibility RPC + final checks.
-- =============================================================================-- 280526_1835_manager_visibility_stable_rpc.sql

-- 280526_1835_manager_visibility_stable_rpc.sql
-- Unified manager queue RPCs: works with full hierarchy (TL → executive → manager → admin)
-- and shortened paths (skip_to_manager / skip_to_admin / no hierarchy).
-- Safe to re-run after backup restore (drops conflicting signatures first).

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS approved_by uuid;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Drop all known overloads / prior signatures (42P13: cannot rename input parameter).
DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);
DROP FUNCTION IF EXISTS public.list_manager_level2_expenses(uuid);
DROP FUNCTION IF EXISTS public.manager_expense_visible_to_user(uuid, uuid);
DROP FUNCTION IF EXISTS public.manager_expense_visible_to_user(public.expenses, uuid);
-- repair_expense_for_manager_review: created in Section 2 migration 18 (jsonb); do not drop here.

-- Visibility: team manager, assignments, reporting line (used by engineer review).
CREATE OR REPLACE FUNCTION public.manager_expense_visible_to_user(
  e public.expenses,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p_user_id IS NOT NULL
    AND (
      e.assigned_engineer_id = p_user_id
      OR e.assigned_reviewer_id = p_user_id
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = p_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.team_members tm
        JOIN public.teams t
          ON t.id = tm.team_id
         AND t.organization_id = tm.organization_id
        WHERE tm.user_id = e.user_id
          AND tm.organization_id = e.organization_id
          AND t.manager_user_id = p_user_id
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.expense_manager_can_review(
  e public.expenses,
  v_uid uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = e.organization_id
      AND om.role = 'engineer'
      AND om.is_active = true
  )
  AND public.manager_expense_visible_to_user(e, v_uid);
$$;

-- Wrapper for app RPC calls (ExpenseService uses expense id + manager id).
CREATE OR REPLACE FUNCTION public.manager_expense_visible_to_user(
  p_expense_id uuid,
  p_manager_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.manager_expense_visible_to_user(e, p_manager_id)
  FROM public.expenses e
  WHERE e.id = p_expense_id;
$$;

-- Executive advanced to manager but status not updated (5-tier stuck rows).
CREATE OR REPLACE FUNCTION public.expense_executive_handoff_in_audit(e public.expenses)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.audit_logs al
    WHERE al.expense_id = e.id
      AND al.action = 'tier_advanced'
      AND (
        al.comment ILIKE '%advanced to engineer%'
        OR (
          al.comment ILIKE '%verified at executive%'
          AND al.comment ILIKE '%advanced to%'
        )
      )
  );
$$;

-- Manager-actionable: full hierarchy, skip_to_manager (engineer tier), and legacy non-hierarchy.
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
          'level_1_verified'::public.expense_status,
          'level_2_verified'::public.expense_status
        )
      )
      OR (
        e.approval_tier IS NULL
        AND e.status IN ('submitted'::public.expense_status, 'edited'::public.expense_status)
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

-- Parameter name p_organization_id (matches migrations 243200/243300; required for CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.list_manager_pending_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT e.*
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND (
      public.expense_ready_for_manager_review(e)
      OR public.expense_executive_handoff_in_audit(e)
    )
    AND public.manager_expense_visible_to_user(e, auth.uid())
    AND e.status NOT IN ('verified', 'approved', 'rejected')
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = p_organization_id
        AND om.is_active = true
        AND om.role = 'engineer'
    )
  ORDER BY e.updated_at DESC;
$$;

REVOKE ALL ON FUNCTION public.manager_expense_visible_to_user(public.expenses, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manager_expense_visible_to_user(public.expenses, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.manager_expense_visible_to_user(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manager_expense_visible_to_user(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_manager_can_review(public.expenses, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.expense_executive_handoff_in_audit(public.expenses) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_executive_handoff_in_audit(public.expenses) TO authenticated;

REVOKE ALL ON FUNCTION public.expense_ready_for_manager_review(public.expenses) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expense_ready_for_manager_review(public.expenses) TO authenticated;

REVOKE ALL ON FUNCTION public.list_manager_pending_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_pending_expenses(uuid) TO authenticated;

-- =============================================================================
-- VERIFICATION (read results)
-- =============================================================================

SELECT 'expenses' AS tbl, COUNT(*)::bigint AS cnt FROM public.expenses
UNION ALL SELECT 'attachments', COUNT(*) FROM public.attachments
UNION ALL SELECT 'profiles', COUNT(*) FROM public.profiles
UNION ALL SELECT 'organizations', COUNT(*) FROM public.organizations;

SELECT COUNT(*) AS attachments_still_on_old_project
FROM public.attachments
WHERE file_url LIKE '%briypgrgqagbexudarba%';

SELECT COUNT(*) AS receipt_files_in_storage
FROM storage.objects
WHERE bucket_id = 'receipts';

-- Next (not SQL): npm run post-restore:storage
