-- Re-route expenses already Level-1 verified (or stuck submitted after TL verify) to the
-- executive / Level-2 queue WITHOUT resubmitting. Safe to run multiple times.

WITH candidates AS (
  SELECT
    e.id,
    e.organization_id,
    e.user_id,
    e.assigned_reviewer_id,
    e.assigned_engineer_id,
    e.status
  FROM public.expenses e
  WHERE (
      e.status = 'level_1_verified'::public.expense_status
      AND COALESCE(e.approval_tier, '') <> 'executive'
    )
    OR (
      e.status IN ('submitted'::public.expense_status, 'edited'::public.expense_status)
      AND EXISTS (
        SELECT 1
        FROM public.audit_logs al
        WHERE al.expense_id = e.id
          AND al.action = 'tier_advanced'
          AND al.comment ILIKE '%team_leader%'
      )
    )
),
submitter_team AS (
  SELECT
    c.id AS expense_id,
    t.executive_user_id
  FROM candidates c
  JOIN public.team_members tm
    ON tm.user_id = c.user_id
    AND tm.organization_id = c.organization_id
  JOIN public.teams t ON t.id = tm.team_id
),
tl_supervisor AS (
  SELECT
    c.id AS expense_id,
    p_boss.user_id AS exec_id
  FROM candidates c
  JOIN public.profiles p_tl
    ON p_tl.user_id = COALESCE(c.assigned_reviewer_id, c.assigned_engineer_id)
  JOIN public.profiles p_boss
    ON p_boss.user_id = p_tl.reporting_engineer_id
  JOIN public.organization_memberships om
    ON om.user_id = p_boss.user_id
    AND om.organization_id = c.organization_id
    AND om.role = 'executive'
    AND om.is_active = true
),
resolved AS (
  SELECT
    c.id AS expense_id,
    COALESCE(st.executive_user_id, ts.exec_id) AS executive_user_id
  FROM candidates c
  LEFT JOIN submitter_team st ON st.expense_id = c.id
  LEFT JOIN tl_supervisor ts ON ts.expense_id = c.id
  WHERE COALESCE(st.executive_user_id, ts.exec_id) IS NOT NULL
)
UPDATE public.expenses e
SET
  status = 'level_1_verified'::public.expense_status,
  approval_tier = 'executive',
  assigned_reviewer_id = r.executive_user_id,
  assigned_engineer_id = r.executive_user_id,
  updated_at = now()
FROM resolved r
WHERE e.id = r.expense_id;
