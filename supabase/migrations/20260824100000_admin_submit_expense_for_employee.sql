-- DOC-107 — admin submits an expense on behalf of an employee.
--
-- Scope: backup instance only (pesowise-backup-supabase.unimisk.com). Not for
-- production until explicitly requested.
--
-- WHY THIS CAN'T BE A PLAIN INSERT
--   expenses' INSERT policy requires auth.uid() = user_id. An admin's session
--   can never satisfy that for a row owned by someone else, by design — so this
--   needs a SECURITY DEFINER RPC that does its own authorization instead of
--   relying on RLS, exactly like apply_expense_correction /
--   review_admin_verify_expense already do in this codebase.
--
-- WHY THE ROUTING LOGIC BELOW IS A LINE-BY-LINE PORT, NOT A REWRITE
--   Self-submission's hierarchy routing (which reviewer/tier an expense lands
--   on) lives in TypeScript: src/lib/approvalHierarchy.ts
--   (resolveInitialAssignment / resolveManagingEngineerId) plus
--   ExpenseService.submitExpense's engineer-branch special case. That is
--   real, tested business logic already relied on by every normal submission.
--   Reinventing it here would risk silently misrouting an admin-submitted
--   expense to the wrong reviewer — a correctness bug in the review pipeline,
--   not just in this new feature. So every branch below is annotated with the
--   exact TS source lines it mirrors; changes to the hierarchy engine must be
--   mirrored here too.
--
-- WHAT IS DELIBERATELY NOT REPLICATED
--   The notification *branching* in submitExpense (ExpenseService.ts:1907-1980)
--   has several overlapping legacy branches for cosmetic wording. Only what
--   drives WHO CAN ACT on the expense (approval_tier / assigned_reviewer_id /
--   assigned_engineer_id) is ported exactly; the notification target is
--   simplified to "assigned reviewer, else assigned engineer, else all admins"
--   — correct in every case, just without the legacy branch's wording nuance.
--   Custom form fields are out of scope for this first version; the picker
--   only fills the universal fields (title, destination, date, purpose,
--   category, amount) the request described.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Provenance column. NULL = self-submitted (every existing row and every
--    normal future submission). Set = which admin created it on this
--    employee's behalf. This is the structured source of truth the UI badge
--    and any future reporting read from; the audit_logs rows below are the
--    human-readable trail.
-- ---------------------------------------------------------------------------
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS created_by_admin_id uuid NULL REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_expenses_created_by_admin_id
  ON public.expenses (created_by_admin_id)
  WHERE created_by_admin_id IS NOT NULL;

COMMENT ON COLUMN public.expenses.created_by_admin_id IS
  'Set when an admin created this expense on behalf of the employee in user_id. NULL for every self-submitted expense.';

-- ---------------------------------------------------------------------------
-- 2. Hierarchy routing port. Mirrors src/lib/approvalHierarchy.ts exactly.
--    Kept private (no grants) — only the main RPC below calls these.
-- ---------------------------------------------------------------------------

-- Mirrors getEnabledTiers().
CREATE OR REPLACE FUNCTION public._admin_submit_enabled_tiers_v1(
  p_team_leader boolean, p_executive boolean
) RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT ARRAY(
    SELECT t FROM unnest(ARRAY[
      CASE WHEN p_team_leader THEN 'team_leader' END,
      CASE WHEN p_executive THEN 'executive' END,
      'engineer', 'admin'
    ]) AS u(t)
    WHERE t IS NOT NULL
  );
$fn$;

-- Mirrors membershipRoleToTier().
CREATE OR REPLACE FUNCTION public._admin_submit_role_to_tier_v1(p_role text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE p_role
    WHEN 'team_leader' THEN 'team_leader'
    WHEN 'executive' THEN 'executive'
    WHEN 'engineer' THEN 'engineer'
    WHEN 'admin' THEN 'admin'
    ELSE NULL
  END;
$fn$;

-- Mirrors firstTierAfterSkip().
CREATE OR REPLACE FUNCTION public._admin_submit_first_tier_v1(
  p_team_leader boolean, p_executive boolean, p_routing_mode text
) RETURNS text LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_routing_mode = 'skip_to_admin' THEN 'admin'
    WHEN p_routing_mode = 'skip_to_manager' THEN 'engineer'
    ELSE COALESCE(
      (public._admin_submit_enabled_tiers_v1(p_team_leader, p_executive))[1],
      'engineer'
    )
  END;
$fn$;

-- Mirrors adjustStartTierForSubmitterRole().
CREATE OR REPLACE FUNCTION public._admin_submit_adjust_start_tier_v1(
  p_start_tier text, p_submitter_role text, p_team_leader boolean, p_executive boolean
) RETURNS text LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  v_submitter_tier text := public._admin_submit_role_to_tier_v1(p_submitter_role);
  v_order text[] := public._admin_submit_enabled_tiers_v1(p_team_leader, p_executive);
  v_start_idx int;
  v_submitter_idx int;
  v_next_idx int;
BEGIN
  IF v_submitter_tier IS NULL OR v_submitter_tier = 'admin' THEN
    RETURN p_start_tier;
  END IF;
  v_start_idx := array_position(v_order, p_start_tier);
  v_submitter_idx := array_position(v_order, v_submitter_tier);
  IF v_submitter_idx IS NULL THEN RETURN p_start_tier; END IF;
  v_next_idx := GREATEST(COALESCE(v_start_idx, 1), v_submitter_idx + 1);
  RETURN COALESCE(v_order[v_next_idx], 'admin');
END;
$fn$;

-- Mirrors resolveExecutiveReviewerId(). verifier_* inputs are always NULL at
-- initial submission (submitExpense's hierarchyInput never sets them either).
CREATE OR REPLACE FUNCTION public._admin_submit_resolve_executive_v1(
  p_reporting_engineer_id uuid, p_reporting_supervisor_role text, p_team_executive_id uuid
) RETURNS uuid LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_reporting_supervisor_role = 'executive' THEN p_reporting_engineer_id
    ELSE p_team_executive_id
  END;
$fn$;

-- Mirrors resolveReviewerForTier().
CREATE OR REPLACE FUNCTION public._admin_submit_reviewer_for_tier_v1(
  p_tier text, p_reporting_engineer_id uuid, p_reporting_supervisor_role text,
  p_team_leader_id uuid, p_team_manager_id uuid, p_team_executive_id uuid,
  p_fallback_admin_id uuid
) RETURNS uuid LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE p_tier
    WHEN 'team_leader' THEN COALESCE(
      CASE WHEN p_reporting_supervisor_role = 'team_leader' THEN p_reporting_engineer_id END,
      p_team_leader_id
    )
    WHEN 'executive' THEN public._admin_submit_resolve_executive_v1(
      p_reporting_engineer_id, p_reporting_supervisor_role, p_team_executive_id
    )
    WHEN 'engineer' THEN COALESCE(
      CASE WHEN p_reporting_supervisor_role IN ('engineer', 'admin') THEN p_reporting_engineer_id END,
      p_team_manager_id,
      p_reporting_engineer_id
    )
    ELSE p_fallback_admin_id
  END;
$fn$;

-- Mirrors assignmentForTier() + resolveManagingEngineerForAssignment(), returning
-- (approval_tier, assigned_reviewer_id, assigned_engineer_id).
CREATE OR REPLACE FUNCTION public._admin_submit_assignment_for_tier_v1(
  p_tier text, p_reviewer_id uuid,
  p_reporting_engineer_id uuid, p_reporting_supervisor_role text,
  p_team_leader_id uuid, p_team_manager_id uuid, p_team_executive_id uuid,
  p_fallback_admin_id uuid
) RETURNS TABLE (approval_tier text, assigned_reviewer_id uuid, assigned_engineer_id uuid)
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  v_managing_engineer_id uuid;
BEGIN
  IF p_tier = 'admin' THEN
    RETURN QUERY SELECT 'admin'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  v_managing_engineer_id := public._admin_submit_reviewer_for_tier_v1(
    'engineer', p_reporting_engineer_id, p_reporting_supervisor_role,
    p_team_leader_id, p_team_manager_id, p_team_executive_id, p_fallback_admin_id
  );

  RETURN QUERY SELECT
    p_tier,
    p_reviewer_id,
    CASE WHEN p_tier = 'engineer' THEN p_reviewer_id
         ELSE COALESCE(v_managing_engineer_id, p_reviewer_id) END;
END;
$fn$;

-- Mirrors findNextResolvableTier() + resolveInitialAssignment()'s hierarchy-on
-- branch. Walks enabled tiers from start_tier until one resolves a reviewer
-- (or hits 'admin', which always resolves).
CREATE OR REPLACE FUNCTION public._admin_submit_resolve_assignment_v1(
  p_team_leader boolean, p_executive boolean, p_start_tier text,
  p_reporting_engineer_id uuid, p_reporting_supervisor_role text,
  p_team_leader_id uuid, p_team_manager_id uuid, p_team_executive_id uuid,
  p_fallback_admin_id uuid
) RETURNS TABLE (approval_tier text, assigned_reviewer_id uuid, assigned_engineer_id uuid)
LANGUAGE plpgsql IMMUTABLE
AS $fn$
DECLARE
  v_order text[] := public._admin_submit_enabled_tiers_v1(p_team_leader, p_executive);
  v_start_idx int := GREATEST(COALESCE(array_position(v_order, p_start_tier), 1), 1);
  v_tier text;
  v_reviewer uuid;
  i int;
BEGIN
  FOR i IN v_start_idx .. array_length(v_order, 1) LOOP
    v_tier := v_order[i];
    v_reviewer := public._admin_submit_reviewer_for_tier_v1(
      v_tier, p_reporting_engineer_id, p_reporting_supervisor_role,
      p_team_leader_id, p_team_manager_id, p_team_executive_id, p_fallback_admin_id
    );
    IF v_tier = 'admin' OR v_reviewer IS NOT NULL THEN
      RETURN QUERY SELECT * FROM public._admin_submit_assignment_for_tier_v1(
        v_tier, v_reviewer, p_reporting_engineer_id, p_reporting_supervisor_role,
        p_team_leader_id, p_team_manager_id, p_team_executive_id, p_fallback_admin_id
      );
      RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT * FROM public._admin_submit_assignment_for_tier_v1(
    'admin', NULL, p_reporting_engineer_id, p_reporting_supervisor_role,
    p_team_leader_id, p_team_manager_id, p_team_executive_id, p_fallback_admin_id
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The RPC itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_submit_expense_for_employee_v1(
  p_organization_id uuid,
  p_employee_id     uuid,
  p_title           text,
  p_destination     text,
  p_trip_start      date,
  p_trip_end        date,
  p_category        text,
  p_amount          numeric,
  p_purpose         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_admin_id           uuid := auth.uid();
  v_admin_name          text;
  v_employee_name       text;
  v_employee_role       text;
  v_expense_id          uuid;

  -- Hierarchy context (employee's own — never the admin's).
  v_flags_approval      boolean;
  v_flags_tl            boolean;
  v_flags_exec          boolean;
  v_teams_enabled       boolean;
  v_reporting_engineer  uuid;
  v_reporting_sup_role  text;
  v_submitter_role      text;
  v_fallback_admin      uuid;
  v_team_id             uuid;
  v_team_routing_mode   text;
  v_team_leader_id      uuid;
  v_team_manager_id     uuid;
  v_team_executive_id   uuid;
  v_start_tier          text;

  v_approval_tier       text;
  v_assigned_reviewer   uuid;
  v_assigned_engineer   uuid;

  v_notify_target       uuid;
  v_admin_row           RECORD;
BEGIN
  ----------------------------------------------------------------------------
  -- Authorization. Own checks, not RLS — this function bypasses RLS by design.
  ----------------------------------------------------------------------------
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_employee_id IS NULL THEN
    RAISE EXCEPTION 'employee is required' USING ERRCODE = '22023';
  END IF;
  IF p_employee_id = v_admin_id THEN
    RAISE EXCEPTION 'Use the regular Add Expense page to submit your own expenses' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE user_id = v_admin_id AND organization_id = p_organization_id
      AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'not permitted: caller is not an active admin of this organization' USING ERRCODE = '42501';
  END IF;

  SELECT role::text INTO v_employee_role
  FROM public.organization_memberships
  WHERE user_id = p_employee_id AND organization_id = p_organization_id AND is_active = true;

  IF v_employee_role IS NULL THEN
    RAISE EXCEPTION 'employee is not an active member of this organization' USING ERRCODE = '22023';
  END IF;

  -- Same business rule the self-submit INSERT policy enforces (290529_1700_cashier_accountant_mode.sql).
  IF public.is_accountant_cashier(p_employee_id, p_organization_id) THEN
    RAISE EXCEPTION 'this employee is an accountant-cashier and cannot have expenses submitted' USING ERRCODE = '22023';
  END IF;
  IF v_employee_role = 'cashier' AND NOT EXISTS (
    SELECT 1 FROM public.organization_settings os
    WHERE os.organization_id = p_organization_id AND os.allow_cashier_expense_submission = true
  ) THEN
    RAISE EXCEPTION 'cashier expense submission is not enabled for this organization' USING ERRCODE = '22023';
  END IF;

  ----------------------------------------------------------------------------
  -- Field validation. The picker has no attachment step by design: only an
  -- admin can reach this RPC, so the bill-photo-above-amount rule never
  -- applies here — there is deliberately no attachment check in this function.
  ----------------------------------------------------------------------------
  IF btrim(COALESCE(p_title, '')) = '' THEN
    RAISE EXCEPTION 'title is required' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_destination, '')) = '' THEN
    RAISE EXCEPTION 'destination is required' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_category, '')) = '' THEN
    RAISE EXCEPTION 'category is required' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF p_trip_start IS NULL OR p_trip_end IS NULL THEN
    RAISE EXCEPTION 'expense date is required' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(btrim(name), ''), 'Admin') INTO v_admin_name
  FROM public.profiles WHERE user_id = v_admin_id AND organization_id = p_organization_id;
  SELECT COALESCE(NULLIF(btrim(name), ''), 'Employee') INTO v_employee_name
  FROM public.profiles WHERE user_id = p_employee_id AND organization_id = p_organization_id;

  ----------------------------------------------------------------------------
  -- Insert the expense directly as 'submitted' — draft has no purpose here,
  -- there is no attachment step to wait on. created_by_admin_id records who
  -- acted; user_id stays the employee, so every RLS read policy, dashboard
  -- query and review-queue filter treats this exactly like their own expense.
  ----------------------------------------------------------------------------
  IF v_employee_role = 'engineer' THEN
    -- Mirrors ExpenseService.submitExpense's engineer branch (lines 1765-1828):
    -- engineers' expenses skip the hierarchy engine and go straight to admin.
    INSERT INTO public.expenses (
      user_id, organization_id, title, destination, trip_start, trip_end,
      purpose, category, total_amount, status,
      approval_tier, assigned_reviewer_id, assigned_engineer_id,
      created_by_admin_id
    ) VALUES (
      p_employee_id, p_organization_id, p_title, p_destination, p_trip_start, p_trip_end,
      p_purpose, p_category, p_amount, 'submitted',
      NULL, NULL, NULL,
      v_admin_id
    ) RETURNING id INTO v_expense_id;
  ELSE
    SELECT ogf1.enabled, ogf2.enabled, ogf3.enabled, ogf4.enabled
      INTO v_flags_approval, v_flags_tl, v_flags_exec, v_teams_enabled
    FROM (SELECT true) x
    LEFT JOIN public.organization_features ogf1
      ON ogf1.organization_id = p_organization_id AND ogf1.feature_key = 'approval_hierarchy'
    LEFT JOIN public.organization_features ogf2
      ON ogf2.organization_id = p_organization_id AND ogf2.feature_key = 'hierarchy_team_leader'
    LEFT JOIN public.organization_features ogf3
      ON ogf3.organization_id = p_organization_id AND ogf3.feature_key = 'hierarchy_executive'
    LEFT JOIN public.organization_features ogf4
      ON ogf4.organization_id = p_organization_id AND ogf4.feature_key = 'teams_enabled';
    v_flags_approval := COALESCE(v_flags_approval, false);
    v_flags_tl := v_flags_approval AND COALESCE(v_flags_tl, false);
    v_flags_exec := v_flags_approval AND COALESCE(v_flags_exec, false);
    v_teams_enabled := COALESCE(v_teams_enabled, false);

    SELECT reporting_engineer_id INTO v_reporting_engineer
    FROM public.profiles WHERE user_id = p_employee_id AND organization_id = p_organization_id;

    IF v_reporting_engineer IS NOT NULL THEN
      SELECT role::text INTO v_reporting_sup_role
      FROM public.organization_memberships
      WHERE user_id = v_reporting_engineer AND organization_id = p_organization_id AND is_active = true;
    END IF;

    v_submitter_role := v_employee_role;

    IF v_flags_approval THEN
      IF v_teams_enabled THEN
        SELECT t.id, t.routing_mode, t.team_leader_user_id, t.manager_user_id, t.executive_user_id
          INTO v_team_id, v_team_routing_mode, v_team_leader_id, v_team_manager_id, v_team_executive_id
        FROM public.team_members tm
        JOIN public.teams t ON t.id = tm.team_id AND t.organization_id = p_organization_id
        WHERE tm.user_id = p_employee_id AND tm.organization_id = p_organization_id
        LIMIT 1;
      END IF;
      SELECT user_id INTO v_fallback_admin
      FROM public.organization_memberships
      WHERE organization_id = p_organization_id AND role = 'admin' AND is_active = true
      LIMIT 1;
    END IF;

    IF NOT v_flags_approval THEN
      -- Mirrors submitExpense's non-hierarchy else branch (lines 1867-1875).
      v_approval_tier := NULL;
      v_assigned_reviewer := v_reporting_engineer;
      v_assigned_engineer := v_reporting_engineer;
    ELSE
      -- Mirrors resolveInitialAssignment()'s hierarchy-on branch (lines 385-410)
      -- plus resolveManagingEngineerId() overriding assigned_engineer_id
      -- (submitExpense lines 1858-1864).
      v_start_tier := public._admin_submit_adjust_start_tier_v1(
        public._admin_submit_first_tier_v1(v_flags_tl, v_flags_exec, v_team_routing_mode),
        v_submitter_role, v_flags_tl, v_flags_exec
      );
      SELECT approval_tier, assigned_reviewer_id, assigned_engineer_id
        INTO v_approval_tier, v_assigned_reviewer, v_assigned_engineer
      FROM public._admin_submit_resolve_assignment_v1(
        v_flags_tl, v_flags_exec, v_start_tier,
        v_reporting_engineer, v_reporting_sup_role,
        v_team_leader_id, v_team_manager_id, v_team_executive_id, v_fallback_admin
      );

      -- resolveManagingEngineerId(): the engineer-tier managing reviewer takes
      -- precedence over whatever assignmentForTier already put in
      -- assigned_engineer_id, when one resolves.
      DECLARE
        v_managing_engineer uuid;
      BEGIN
        SELECT assigned_reviewer_id INTO v_managing_engineer
        FROM public._admin_submit_resolve_assignment_v1(
          v_flags_tl, v_flags_exec, 'engineer',
          v_reporting_engineer, v_reporting_sup_role,
          v_team_leader_id, v_team_manager_id, v_team_executive_id, v_fallback_admin
        )
        WHERE approval_tier = 'engineer';
        IF v_managing_engineer IS NOT NULL THEN
          v_assigned_engineer := v_managing_engineer;
        END IF;
      END;
    END IF;

    INSERT INTO public.expenses (
      user_id, organization_id, title, destination, trip_start, trip_end,
      purpose, category, total_amount, status,
      approval_tier, assigned_reviewer_id, assigned_engineer_id,
      created_by_admin_id
    ) VALUES (
      p_employee_id, p_organization_id, p_title, p_destination, p_trip_start, p_trip_end,
      p_purpose, p_category, p_amount, 'submitted',
      v_approval_tier, v_assigned_reviewer, v_assigned_engineer,
      v_admin_id
    ) RETURNING id INTO v_expense_id;
  END IF;

  ----------------------------------------------------------------------------
  -- Audit trail. Actor is the admin on both rows — this IS the "created by
  -- admin" / "submitted by admin" history the feature requires. Both actions
  -- are ones ExpenseDetail's timeline already renders (expense_created,
  -- expense_submitted); no timeline UI change was needed.
  ----------------------------------------------------------------------------
  INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
  VALUES (
    v_expense_id, v_admin_id, p_organization_id, 'expense_created',
    format('Expense created by admin %s on behalf of %s', v_admin_name, v_employee_name)
  );
  INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
  VALUES (
    v_expense_id, v_admin_id, p_organization_id, 'expense_submitted',
    format('Expense submitted by admin %s on behalf of %s', v_admin_name, v_employee_name)
  );

  ----------------------------------------------------------------------------
  -- Notifications. Simplified target selection (see file header) — reviewer
  -- if assigned, else the review-owning engineer, else every active admin.
  -- Employee notification is new: self-submission never notifies the
  -- submitter, but here the employee didn't act, so their dashboard's
  -- realtime subscription (Dashboard.tsx, filters notifications by their own
  -- user_id) needs this row to update live.
  ----------------------------------------------------------------------------
  v_notify_target := COALESCE(v_assigned_reviewer, v_assigned_engineer);
  IF v_notify_target IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, organization_id, type, title, message, expense_id)
    VALUES (
      v_notify_target, p_organization_id, 'expense_submitted', 'New Expense Claim',
      format('%s has submitted a new expense: "%s"', v_employee_name, p_title),
      v_expense_id
    );
  ELSE
    FOR v_admin_row IN
      SELECT user_id FROM public.organization_memberships
      WHERE organization_id = p_organization_id AND role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (user_id, organization_id, type, title, message, expense_id)
      VALUES (
        v_admin_row.user_id, p_organization_id, 'expense_submitted', 'New Expense Claim',
        format('%s has submitted a new expense: "%s"', v_employee_name, p_title),
        v_expense_id
      );
    END LOOP;
  END IF;

  INSERT INTO public.notifications (user_id, organization_id, type, title, message, expense_id)
  VALUES (
    p_employee_id, p_organization_id, 'expense_submitted_by_admin', 'Expense Submitted',
    format('%s submitted an expense on your behalf: "%s"', v_admin_name, p_title),
    v_expense_id
  );

  RETURN jsonb_build_object(
    'expense_id', v_expense_id,
    'status', 'submitted',
    'approval_tier', v_approval_tier,
    'assigned_reviewer_id', v_assigned_reviewer,
    'assigned_engineer_id', v_assigned_engineer
  );
END;
$fn$;

-- Any authenticated user may call this; the function rejects non-admins itself
-- (same pattern as create_expense_report_export_job_v1 / apply_expense_correction).
GRANT EXECUTE ON FUNCTION public.admin_submit_expense_for_employee_v1(
  uuid, uuid, text, text, date, date, text, numeric, text
) TO authenticated;

COMMIT;
