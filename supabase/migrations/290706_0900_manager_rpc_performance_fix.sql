-- 290706_0900_manager_rpc_performance_fix.sql
--
-- Fixes:
--   1. list_manager_pending_expenses timing out (1.6 min page load)
--   2. Manager cannot see level_2_verified expenses after executive approval
--
-- Root cause: both RPCs called per-row SQL functions that themselves ran
-- correlated subqueries on every expense row:
--
--   • expense_executive_handoff_in_audit(e)  -- ILIKE scan on audit_logs PER ROW (called twice)
--   • manager_expense_visible_to_user(e, uid) -- 3-5 EXISTS subqueries on profiles/team_members PER ROW
--
-- With N expenses this produces O(N×5) queries → statement timeout.
--
-- Fix: rewrite both RPCs using CTEs.
--   • Pre-compute the manager's visible user IDs once (direct_reports, l2_reports, team_users).
--   • Pre-compute executive-handoff expense IDs with a single org-scoped audit_logs scan.
--   • Filter expenses using IN / direct column comparisons — no per-row function calls.
--
-- Existing helper functions (expense_executive_handoff_in_audit,
-- expense_ready_for_manager_review, manager_expense_visible_to_user) are kept intact
-- as other callers may reference them.

-- ─── Supporting indexes ───────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_expenses_org_status
  ON public.expenses(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_expenses_org_updated_at
  ON public.expenses(organization_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_action
  ON public.audit_logs(organization_id, action);

CREATE INDEX IF NOT EXISTS idx_profiles_org_reporting_engineer
  ON public.profiles(organization_id, reporting_engineer_id);

CREATE INDEX IF NOT EXISTS idx_team_members_org_team_user
  ON public.team_members(organization_id, team_id, user_id);

CREATE INDEX IF NOT EXISTS idx_teams_org_manager
  ON public.teams(organization_id, manager_user_id);

-- ─── list_manager_pending_expenses — CTE rewrite ─────────────────────────────
--
-- Returns the manager's actionable expense queue plus completed items the manager
-- verified/approved. Uses set-based CTEs; zero per-row function calls.

DROP FUNCTION IF EXISTS public.list_manager_pending_expenses(uuid);

CREATE FUNCTION public.list_manager_pending_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  -- 1. Verify caller is an active engineer in this org (gate; returns 0 rows if not).
  caller AS (
    SELECT 1
    FROM public.organization_memberships
    WHERE user_id         = auth.uid()
      AND organization_id = p_organization_id
      AND is_active       = true
      AND role            = 'engineer'
    LIMIT 1
  ),
  -- 2. Direct reports of this manager.
  direct_reports AS (
    SELECT p.user_id
    FROM public.profiles p
    WHERE p.organization_id       = p_organization_id
      AND p.reporting_engineer_id = auth.uid()
  ),
  -- 3. Level-2 reports: employees who report to a direct report.
  l2_reports AS (
    SELECT p.user_id
    FROM public.profiles p
    WHERE p.organization_id       = p_organization_id
      AND p.reporting_engineer_id IN (SELECT user_id FROM direct_reports)
  ),
  -- 4. Members of teams this manager manages.
  team_users AS (
    SELECT tm.user_id
    FROM public.team_members tm
    JOIN public.teams t
      ON  t.id              = tm.team_id
      AND t.organization_id = p_organization_id
    WHERE t.manager_user_id   = auth.uid()
      AND tm.organization_id  = p_organization_id
  ),
  -- 5. Union of all user IDs visible to the manager.
  visible_users AS (
    SELECT user_id FROM direct_reports
    UNION
    SELECT user_id FROM l2_reports
    UNION
    SELECT user_id FROM team_users
  ),
  -- 6. Expense IDs where executive advanced to engineer-level — single bulk scan.
  --    Replaces expense_executive_handoff_in_audit() called per row (1→N queries).
  handoff_ids AS (
    SELECT DISTINCT al.expense_id
    FROM public.audit_logs al
    WHERE al.organization_id = p_organization_id
      AND al.action          = 'tier_advanced'
      AND (
        al.comment ILIKE '%advanced to engineer%'
        OR (
          al.comment ILIKE '%verified at executive%'
          AND al.comment ILIKE '%advanced to%'
        )
      )
  ),
  -- 7. Expense IDs this manager has actioned (for terminal-status display).
  manager_acted AS (
    SELECT DISTINCT al.expense_id
    FROM public.audit_logs al
    WHERE al.organization_id = p_organization_id
      AND al.user_id         = auth.uid()
      AND al.action IN ('expense_verified', 'expense_approved', 'tier_advanced')
  )
  SELECT DISTINCT e.*
  FROM public.expenses e
  WHERE EXISTS (SELECT 1 FROM caller)
    AND e.organization_id = p_organization_id
    -- Visibility gate: expense owner is in visible set, or expense is directly assigned to manager.
    AND (
      e.user_id               IN (SELECT user_id FROM visible_users)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
    )
    -- Actionability: pending for manager, or terminal and manager was involved.
    AND (
      -- Active (non-terminal) and manager-actionable.
      (
        e.status NOT IN ('verified', 'approved', 'rejected')
        AND (
          -- Executive already approved; manager is next step.
          e.status = 'level_2_verified'
          -- Engineer-tier expenses: hierarchy skipped to manager.
          OR (
            COALESCE(e.approval_tier, '') = 'engineer'
            AND e.status IN (
              'submitted', 'edited', 'under_review',
              'level_1_verified', 'level_2_verified'
            )
          )
          -- Non-hierarchy orgs: no tier set.
          OR (
            e.approval_tier IS NULL
            AND e.status IN ('submitted', 'edited', 'under_review')
          )
          -- 5-tier stuck rows: executive advanced via audit log but status not updated.
          OR e.id IN (SELECT expense_id FROM handoff_ids)
        )
      )
      -- Terminal, but manager was the assigned reviewer or previously actioned this expense.
      OR (
        e.status IN ('verified', 'approved', 'rejected')
        AND (
          e.assigned_engineer_id  = auth.uid()
          OR e.assigned_reviewer_id = auth.uid()
          OR e.id IN (SELECT expense_id FROM manager_acted)
        )
      )
    )
  ORDER BY e.updated_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_manager_pending_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_pending_expenses(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_manager_pending_expenses(uuid) IS
  'Manager actionable queue + completed items manager acted on. CTE-based — no per-row function calls. '
  'Fixes statement timeout caused by per-row audit_logs ILIKE scans and profiles/team_members correlated subqueries.';

-- ─── list_manager_reviewer_expenses — CTE rewrite ────────────────────────────
--
-- Returns all in-review and completed expenses visible to the manager.
-- Same CTE pattern; removes per-row manager_expense_visible_to_user() calls.

DROP FUNCTION IF EXISTS public.list_manager_reviewer_expenses(uuid);

CREATE FUNCTION public.list_manager_reviewer_expenses(p_organization_id uuid)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  caller AS (
    SELECT 1
    FROM public.organization_memberships
    WHERE user_id         = auth.uid()
      AND organization_id = p_organization_id
      AND is_active       = true
      AND role            = 'engineer'
    LIMIT 1
  ),
  direct_reports AS (
    SELECT p.user_id
    FROM public.profiles p
    WHERE p.organization_id       = p_organization_id
      AND p.reporting_engineer_id = auth.uid()
  ),
  l2_reports AS (
    SELECT p.user_id
    FROM public.profiles p
    WHERE p.organization_id       = p_organization_id
      AND p.reporting_engineer_id IN (SELECT user_id FROM direct_reports)
  ),
  team_users AS (
    SELECT tm.user_id
    FROM public.team_members tm
    JOIN public.teams t
      ON  t.id              = tm.team_id
      AND t.organization_id = p_organization_id
    WHERE t.manager_user_id   = auth.uid()
      AND tm.organization_id  = p_organization_id
  ),
  visible_users AS (
    SELECT user_id FROM direct_reports
    UNION
    SELECT user_id FROM l2_reports
    UNION
    SELECT user_id FROM team_users
  )
  SELECT DISTINCT e.*
  FROM public.expenses e
  WHERE EXISTS (SELECT 1 FROM caller)
    AND e.organization_id = p_organization_id
    AND e.status IN (
      'submitted', 'verified', 'approved', 'rejected',
      'edited', 'under_review', 'level_1_verified', 'level_2_verified'
    )
    AND (
      e.user_id               IN (SELECT user_id FROM visible_users)
      OR e.assigned_engineer_id = auth.uid()
      OR e.assigned_reviewer_id = auth.uid()
    )
  ORDER BY e.updated_at DESC;
$$;

REVOKE ALL ON FUNCTION public.list_manager_reviewer_expenses(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_manager_reviewer_expenses(uuid) TO authenticated;

COMMENT ON FUNCTION public.list_manager_reviewer_expenses(uuid) IS
  'All in-review and completed expenses visible to the manager. CTE-based — no per-row function calls.';
