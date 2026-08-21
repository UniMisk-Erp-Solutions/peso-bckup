-- Rollback for supabase/migrations/20260819150000_fail_closed_hierarchy_reviewer_can_act.sql
--
-- Restores the exact prior body (last unmodified definition, captured in
-- supabase/migrations/20260812120000_fix_pending_expense_supervisor_reassignment.sql)
-- WITHOUT the COALESCE(..., false) wrapper — i.e. reintroduces the NULL
-- fail-open behavior. Only use this if the fail-closed version is found to
-- reject some caller that must legitimately be authorized; per the migration's
-- own analysis this should not be possible, but the rollback is provided per
-- policy for every migration.

CREATE OR REPLACE FUNCTION public.expense_hierarchy_reviewer_can_act(e expenses, v_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (
      EXISTS (
        SELECT 1
        FROM public.organization_memberships om
        WHERE om.user_id = v_uid
          AND om.organization_id = e.organization_id
          AND om.is_active = true
          AND (
            (
              om.role = 'team_leader'
              AND (
                e.approval_tier IS NULL
                OR e.approval_tier IN ('team_leader', 'engineer')
              )
            )
            OR (
              om.role = 'executive'
              AND (
                e.approval_tier IS NULL
                OR e.approval_tier IN ('executive', 'engineer')
              )
            )
          )
      )
      AND (
        e.assigned_reviewer_id = v_uid
        OR e.assigned_engineer_id = v_uid
      )
    )
    OR (
      v_uid <> e.user_id
      AND e.status::text IN ('submitted', 'edited', 'under_review')
      AND EXISTS (
        SELECT 1
        FROM public.profiles p
        JOIN public.organization_memberships om
          ON om.user_id = v_uid
         AND om.organization_id = e.organization_id
         AND om.is_active = true
         AND om.role IN ('team_leader', 'executive')
        WHERE p.user_id = e.user_id
          AND p.organization_id = e.organization_id
          AND p.reporting_engineer_id = v_uid
      )
    );
$function$;

GRANT EXECUTE ON FUNCTION public.expense_hierarchy_reviewer_can_act(expenses, uuid) TO PUBLIC;
