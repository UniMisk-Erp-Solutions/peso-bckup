-- Admin submits an expense on behalf of an employee — atomic V2.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- ============================================================================
--
-- SOURCE: Preet-Patel/feature/admin-submit-expense-for-employee, commits
-- 91e6d13e (DOC-107, origin RPC admin_submit_expense_for_employee_v1) and
-- 25ee6150 (DOC-108, admin_bulk_submit_expenses_v1). Full commit history read
-- (16 commits total; only 6 belong to this feature — see
-- Documentations MD/PENDING_MIGRATIONS_PREET_INTEGRATION.md for the full
-- classification of every one of them).
--
-- WHY THIS IS "_v2", NOT A PORT OF THE SOURCE'S "_v1" ARCHITECTURE
--   The source branch used a two-step pattern: admin_submit_expense_for_employee_v1
--   creates the expense (status='submitted', audit rows, notifications, all in
--   ONE transaction) and returns; the caller THEN makes a SEPARATE round trip
--   to replace_expense_form_field_values for custom fields; the caller THEN
--   OPTIONALLY makes a THIRD round trip to verify/approve. The source's own
--   documentation explicitly acknowledges the resulting gap: if the second
--   call fails, an expense already exists, a reviewer has already been
--   notified, and the required custom field is permanently missing unless the
--   UI retries. That is the "the browser can produce an incomplete financial
--   record and someone has already been told about it" failure mode this
--   integration was explicitly instructed not to preserve silently.
--
--   admin_submit_expense_for_employee_v2 below is a single SECURITY DEFINER
--   function that performs authorization, expense creation, custom-field
--   persistence and an optional status transition (verify/approve) INSIDE
--   ONE transaction. If custom-field validation fails, the entire operation
--   rolls back: no expense row survives, no audit row survives, no
--   notification row survives, no reviewer was ever actually told about
--   anything (nothing committed). This directly satisfies the task's Phase 27
--   ordering requirement (validate -> persist -> status transition -> financial
--   effect -> audit/notification -> commit, all-or-nothing) without
--   reinventing custom-field validation or financial logic: it calls the
--   EXISTING, already-shipped replace_expense_form_field_values and
--   review_admin_verify_expense / review_approve_expense_v2 as plain SQL
--   function calls in the same transaction. Nested SECURITY DEFINER calls
--   within one transaction share the same auth.uid() (it comes from the
--   request's JWT claims, not from which function is executing) and the same
--   transaction boundary, so this is a genuine merge, not a client-side
--   orchestration that merely LOOKS atomic.
--
-- WHAT THIS DOES NOT CLOSE (documented, not hidden, per Phase 27's own escape
-- hatch: "if not [fully closable], do not hide the gap; document exactly why")
--   replace_expense_form_field_values does not itself enforce "this template
--   is required" server-side — it validates that every submitted value
--   belongs to the correct organization/category, but a MISSING required
--   field is not rejected by that function today. This is a PRE-EXISTING,
--   system-wide gap: the employee's OWN self-submission path
--   (ExpenseService.submitExpenseBatch) has never enforced this server-side
--   either, only client-side in CategoryFormFieldsSection. Building full
--   required-field enforcement for arbitrary category templates and
--   conditional branches is a real, valuable improvement, but it is a
--   pre-existing gap affecting EVERY expense submission path in this
--   codebase, not something specific to delegation — fixing it here, for
--   this feature alone, would silently diverge admin-submitted expenses from
--   self-submitted ones (an admin-submitted expense could reject a missing
--   field that a self-submitted one would silently accept), which is its own
--   correctness problem. Out of scope for this integration; flagged as a
--   residual, pre-existing, system-wide risk in
--   Documentations MD/admin-submit-expense-for-employee.md.
--
-- WHAT ATOMICITY DOES CLOSE, CONCRETELY, TODAY, WITHOUT THAT FUTURE WORK
--   Every validation that DOES already exist server-side in
--   replace_expense_form_field_values (cross-org template/branch ids,
--   duplicate values, category-membership) now rolls back the WHOLE
--   operation instead of leaving a half-created expense behind. That is a
--   real, immediate correctness improvement over the source branch's
--   architecture, achieved with zero new validation logic invented.
--
-- ROUTING: mirrors src/lib/approvalHierarchy.ts's resolveInitialAssignment /
-- resolveManagingEngineerId, ported into nine private SQL helper functions
-- below (_admin_submit_*), UNCHANGED from the source branch's port. I
-- independently re-verified every one of these nine functions line-by-line
-- against this repository's OWN CURRENT approvalHierarchy.ts (not just
-- trusting the source branch's own claim of parity) before reusing them
-- as-is: confirmed identical control flow for getEnabledTiers,
-- membershipRoleToTier, firstTierAfterSkip, adjustStartTierForSubmitterRole,
-- resolveExecutiveReviewerId, resolveReviewerForTier, assignmentForTier,
-- findNextResolvableTier/resolveInitialAssignment, and the separate
-- resolveManagingEngineerId override. These are Category A (still-needed
-- generic functionality) in the source-commit classification register.
--
-- CRITICAL: routing is computed from the EMPLOYEE's own hierarchy context
-- (reporting_engineer_id, role, team), NEVER the admin's. The admin is only
-- ever auth.uid(); the employee is only ever p_employee_id. See Phase 4/24 of
-- the task instructions this integration follows.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Provenance column. NULL = self-submitted. Set = which admin created it
--    on this employee's behalf. Ported unchanged from the source branch.
-- ---------------------------------------------------------------------------
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS created_by_admin_id uuid NULL REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_expenses_created_by_admin_id
  ON public.expenses (created_by_admin_id)
  WHERE created_by_admin_id IS NOT NULL;

COMMENT ON COLUMN public.expenses.created_by_admin_id IS
  'Set when an admin created this expense on behalf of the employee in user_id. NULL for every self-submitted expense.';

-- ---------------------------------------------------------------------------
-- 2. Idempotency. NEW — the source branch had no idempotency mechanism at
--    all for either the single-submit or bulk RPC, a real gap for a feature
--    whose own bulk path explicitly retries failed rows and whose network
--    conditions (slow admin connections, bulk files) make client-side retry
--    routine. One row per successfully COMMITTED submission; because the
--    INSERT into this table happens in the SAME transaction as the expense
--    creation, a transaction that rolls back (e.g. custom-field validation
--    failure) leaves no idempotency row behind either — so a genuine retry
--    after a real failure is never blocked, only a retry after an ACTUAL
--    success is deduplicated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_submit_expense_idempotency (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  admin_id        uuid NOT NULL REFERENCES auth.users(id),
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  expense_id      uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, admin_id, idempotency_key)
);

COMMENT ON TABLE public.admin_submit_expense_idempotency IS
  'One row per successfully committed admin_submit_expense_for_employee_v2 call that supplied an idempotency key. Written in the same transaction as the expense it maps to, so a rolled-back attempt never reserves a key. Same key + same payload hash => replay the original result. Same key + different payload hash => reject as a conflict.';

ALTER TABLE public.admin_submit_expense_idempotency ENABLE ROW LEVEL SECURITY;

-- No direct client access at all: only the SECURITY DEFINER functions below
-- ever read or write this table (via their elevated privileges, independent
-- of RLS). No policy is defined, so RLS denies every direct client query —
-- deliberate, not an oversight.

REVOKE ALL ON TABLE public.admin_submit_expense_idempotency FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_submit_expense_idempotency FROM anon;
REVOKE ALL ON TABLE public.admin_submit_expense_idempotency FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. Hierarchy routing helpers. Ported unchanged from the source branch (see
--    header note above for the independent re-verification against this
--    repo's own approvalHierarchy.ts). Private: no grants, callable only
--    from the functions in this file.
-- ---------------------------------------------------------------------------

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

CREATE OR REPLACE FUNCTION public._admin_submit_resolve_executive_v1(
  p_reporting_engineer_id uuid, p_reporting_supervisor_role text, p_team_executive_id uuid
) RETURNS uuid LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_reporting_supervisor_role = 'executive' THEN p_reporting_engineer_id
    ELSE p_team_executive_id
  END;
$fn$;

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
-- 4. The atomic RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_submit_expense_for_employee_v2(
  p_organization_id      uuid,
  p_employee_id          uuid,
  p_title                text,
  p_destination          text,
  p_trip_start           date,
  p_trip_end             date,
  p_category             text,
  p_amount               numeric,
  p_purpose              text        DEFAULT NULL,
  p_custom_field_values  jsonb       DEFAULT '[]'::jsonb,
  p_status               text        DEFAULT 'submitted',
  p_status_comment       text        DEFAULT NULL,
  p_idempotency_key      text        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_admin_id           uuid := auth.uid();
  v_admin_name         text;
  v_employee_name      text;
  v_employee_role      text;
  v_expense_id         uuid;
  v_request_hash       text;
  v_existing_expense_id uuid;
  v_existing_hash      text;
  v_field_saved_count  integer;

  v_flags_approval     boolean;
  v_flags_tl           boolean;
  v_flags_exec         boolean;
  v_teams_enabled      boolean;
  v_reporting_engineer uuid;
  v_reporting_sup_role text;
  v_submitter_role     text;
  v_fallback_admin     uuid;
  v_team_id            uuid;
  v_team_routing_mode  text;
  v_team_leader_id     uuid;
  v_team_manager_id    uuid;
  v_team_executive_id  uuid;
  v_start_tier         text;

  v_approval_tier      text;
  v_assigned_reviewer  uuid;
  v_assigned_engineer  uuid;
  v_managing_engineer  uuid;

  v_notify_target      uuid;
  v_admin_row          RECORD;
  v_final_status        text := 'submitted';
BEGIN
  ----------------------------------------------------------------------------
  -- Authorization. Own checks, not RLS — this function bypasses RLS by
  -- design, mirroring apply_expense_correction / review_admin_verify_expense.
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
  IF p_status NOT IN ('submitted', 'verified', 'approved') THEN
    RAISE EXCEPTION 'invalid status choice: %', p_status USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE user_id = v_admin_id AND organization_id = p_organization_id
      AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'not permitted: caller is not an active admin of this organization' USING ERRCODE = '42501';
  END IF;

  -- Cross-org employee id fails here, not with a confusing downstream error:
  -- an inactive-or-nonexistent-in-this-org employee_id resolves v_employee_role
  -- to NULL regardless of whether the uuid is real in a DIFFERENT organization.
  SELECT role::text INTO v_employee_role
  FROM public.organization_memberships
  WHERE user_id = p_employee_id AND organization_id = p_organization_id AND is_active = true;

  IF v_employee_role IS NULL THEN
    RAISE EXCEPTION 'employee is not an active member of this organization' USING ERRCODE = '22023';
  END IF;

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
  -- Idempotency check. Returning early here means NOTHING below this block
  -- runs a second time for a replayed key — including no second audit row,
  -- no second notification, no second status transition.
  ----------------------------------------------------------------------------
  v_request_hash := md5(
    COALESCE(p_employee_id::text, '') || '|' || COALESCE(p_title, '') || '|' ||
    COALESCE(p_destination, '') || '|' || COALESCE(p_trip_start::text, '') || '|' ||
    COALESCE(p_trip_end::text, '') || '|' || COALESCE(p_category, '') || '|' ||
    COALESCE(p_amount::text, '') || '|' || COALESCE(p_purpose, '') || '|' ||
    COALESCE(p_custom_field_values::text, '[]') || '|' || COALESCE(p_status, '') || '|' ||
    COALESCE(p_status_comment, '')
  );

  IF p_idempotency_key IS NOT NULL THEN
    SELECT expense_id, request_hash INTO v_existing_expense_id, v_existing_hash
    FROM public.admin_submit_expense_idempotency
    WHERE organization_id = p_organization_id AND admin_id = v_admin_id
      AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
      IF v_existing_hash IS DISTINCT FROM v_request_hash THEN
        RAISE EXCEPTION 'idempotency key already used with a different request' USING ERRCODE = '23505';
      END IF;
      SELECT status, approval_tier, assigned_reviewer_id, assigned_engineer_id
        INTO v_final_status, v_approval_tier, v_assigned_reviewer, v_assigned_engineer
      FROM public.expenses WHERE id = v_existing_expense_id;
      RETURN jsonb_build_object(
        'expense_id', v_existing_expense_id, 'status', v_final_status,
        'approval_tier', v_approval_tier, 'assigned_reviewer_id', v_assigned_reviewer,
        'assigned_engineer_id', v_assigned_engineer, 'idempotent_replay', true
      );
    END IF;
  END IF;

  ----------------------------------------------------------------------------
  -- Field validation.
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
  IF p_custom_field_values IS NULL OR jsonb_typeof(p_custom_field_values) <> 'array' THEN
    RAISE EXCEPTION 'custom field values must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(btrim(name), ''), 'Admin') INTO v_admin_name
  FROM public.profiles WHERE user_id = v_admin_id AND organization_id = p_organization_id;
  SELECT COALESCE(NULLIF(btrim(name), ''), 'Employee') INTO v_employee_name
  FROM public.profiles WHERE user_id = p_employee_id AND organization_id = p_organization_id;

  ----------------------------------------------------------------------------
  -- Hierarchy routing. Computed from the EMPLOYEE's own context, never the
  -- admin's. Mirrors src/lib/approvalHierarchy.ts (see header note).
  ----------------------------------------------------------------------------
  IF v_employee_role = 'engineer' THEN
    -- Mirrors ExpenseService.submitExpense's engineer branch: engineers'
    -- expenses skip the hierarchy engine and go straight to admin.
    v_approval_tier := NULL;
    v_assigned_reviewer := NULL;
    v_assigned_engineer := NULL;
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
      v_approval_tier := NULL;
      v_assigned_reviewer := v_reporting_engineer;
      v_assigned_engineer := v_reporting_engineer;
    ELSE
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
    END IF;
  END IF;

  ----------------------------------------------------------------------------
  -- Create the expense as 'submitted'. Every later step in this function
  -- (custom fields, status transition) either commits alongside this insert
  -- or rolls it back with everything else — there is no partial state.
  ----------------------------------------------------------------------------
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
  v_final_status := 'submitted';

  ----------------------------------------------------------------------------
  -- Custom fields — SAME TRANSACTION. A validation failure here (cross-org
  -- template/branch id, duplicate value, wrong category) raises, and the
  -- EXCEPTION propagates out of this function, rolling back the INSERT
  -- above along with it. See replace_expense_form_field_values in
  -- 20260701120000_expense_form_field_values_atomic_write.sql for the exact
  -- validation performed; that function already tolerates an org-admin
  -- acting on someone else's expense (verified before writing this file),
  -- so no change was needed there.
  ----------------------------------------------------------------------------
  IF jsonb_array_length(p_custom_field_values) > 0 THEN
    SELECT (public.replace_expense_form_field_values(v_expense_id, p_organization_id, p_custom_field_values) ->> 'saved_count')::integer
      INTO v_field_saved_count;
  END IF;

  ----------------------------------------------------------------------------
  -- Audit trail. Actor is the admin on every row here.
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
  -- Notifications. Same target selection as the source (reviewer, else
  -- managing engineer, else every active admin), plus an employee-facing row
  -- so the employee's own dashboard reflects an expense they did not
  -- themselves create. All within the same transaction: if anything above
  -- this point raised, these never get written either.
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

  ----------------------------------------------------------------------------
  -- Optional status transition — SAME TRANSACTION, canonical RPCs only. No
  -- balance math, no status UPDATE, and no approval authorization logic is
  -- written in this file: review_admin_verify_expense and
  -- review_approve_expense_v2 are called exactly as any other caller would
  -- call them, and remain the single source of truth for what "verified" and
  -- "approved" mean and what they are allowed to do.
  ----------------------------------------------------------------------------
  IF p_status = 'verified' THEN
    PERFORM public.review_admin_verify_expense(v_expense_id, p_status_comment);
    v_final_status := 'verified';
  ELSIF p_status = 'approved' THEN
    -- Segregation of duties: the SAME admin created this expense and is now
    -- approving it — a distinct, explicit, machine-searchable audit action,
    -- not only a comment string, so this scenario can be queried/reported on
    -- without parsing free text.
    PERFORM public.review_approve_expense_v2(v_expense_id, p_status_comment);
    v_final_status := 'approved';
    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (
      v_expense_id, v_admin_id, p_organization_id, 'admin_submitted_and_approved_for_employee',
      format(
        'Admin %s both submitted AND approved this expense on behalf of %s in the same action — no independent review occurred. Reason: %s',
        v_admin_name, v_employee_name, COALESCE(NULLIF(btrim(p_status_comment), ''), '(no reason given)')
      )
    );
  END IF;

  ----------------------------------------------------------------------------
  -- Idempotency record — written last, in the same transaction. If anything
  -- above raised, this INSERT never runs and no key is reserved.
  ----------------------------------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.admin_submit_expense_idempotency
      (organization_id, admin_id, idempotency_key, request_hash, expense_id)
    VALUES (p_organization_id, v_admin_id, p_idempotency_key, v_request_hash, v_expense_id);
  END IF;

  RETURN jsonb_build_object(
    'expense_id', v_expense_id,
    'status', v_final_status,
    'approval_tier', v_approval_tier,
    'assigned_reviewer_id', v_assigned_reviewer,
    'assigned_engineer_id', v_assigned_engineer,
    'custom_fields_saved', COALESCE(v_field_saved_count, 0),
    'idempotent_replay', false
  );
END;
$fn$;

-- PostgreSQL grants PUBLIC EXECUTE on a new function by default (unlike
-- tables) — explicit REVOKE is required to actually restrict this to
-- authenticated callers, matching this codebase's own established
-- convention (e.g. report_daily_project_rows_v1). The source branch's own
-- migration for v1 omitted this REVOKE; closed here rather than re-ported
-- as-is.
REVOKE ALL ON FUNCTION public.admin_submit_expense_for_employee_v2(
  uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_submit_expense_for_employee_v2(
  uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text
) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_submit_expense_for_employee_v2(
  uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text
) TO authenticated;

COMMENT ON FUNCTION public.admin_submit_expense_for_employee_v2(
  uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text
) IS
  'Atomic, idempotent, SECURITY DEFINER admin-delegated expense submission. '
  'Creates the expense, saves custom field values, and optionally applies a '
  'verify/approve status transition (via the canonical, unmodified '
  'review_admin_verify_expense / review_approve_expense_v2) all in one '
  'transaction. Any failure rolls back everything: no partial expense, no '
  'orphaned notification, no incomplete custom-field state.';

-- ---------------------------------------------------------------------------
-- 5. Bulk wrapper. Per-row isolation (one BEGIN/EXCEPTION per row, same
--    pattern as save_form_template_parent_option_configurations_batch_atomically
--    in 20260822100000_form_template_bulk_batch_operations.sql), per-row
--    idempotency key required so a retried chunk cannot double-create rows
--    that already succeeded, upfront admin check so a non-admin caller gets
--    ONE clear rejection instead of N identical ones, employee identifier
--    resolution treats zero-matches and multiple-matches as equally hard
--    errors (never "closest match").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_bulk_submit_expenses_v2(
  p_organization_id uuid,
  p_rows            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_admin_id      uuid := auth.uid();
  v_row           jsonb;
  v_row_index     integer;
  v_employee_id   text;
  v_email         text;
  v_matches       uuid[];
  v_employee_uuid uuid;
  v_submit_result jsonb;
  v_results       jsonb := '[]'::jsonb;
  v_ok_count      integer := 0;
  v_fail_count    integer := 0;
  v_client_op_id  text;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE user_id = v_admin_id AND organization_id = p_organization_id
      AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'not permitted: caller is not an active admin of this organization' USING ERRCODE = '42501';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'rows is empty' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 250 THEN
    RAISE EXCEPTION 'too many rows in one batch (%): max 250 — chunk the request', jsonb_array_length(p_rows)
      USING ERRCODE = '22023';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_row_index := (v_row->>'row_index')::integer;

    BEGIN
      v_employee_id := NULLIF(btrim(COALESCE(v_row->>'employee_id', '')), '');
      v_email       := NULLIF(btrim(COALESCE(v_row->>'email', '')), '');
      v_employee_uuid := NULL;
      v_matches := NULL;
      -- Every row needs its own stable key so a re-submitted chunk cannot
      -- create a duplicate expense for a row that already succeeded.
      v_client_op_id := NULLIF(btrim(COALESCE(v_row->>'client_operation_id', '')), '');
      IF v_client_op_id IS NULL THEN
        RAISE EXCEPTION 'row is missing client_operation_id';
      END IF;

      IF v_employee_id IS NOT NULL THEN
        SELECT array_agg(user_id) INTO v_matches
        FROM public.profiles
        WHERE organization_id = p_organization_id AND employee_id = v_employee_id;

        IF v_matches IS NULL OR array_length(v_matches, 1) = 0 THEN
          RAISE EXCEPTION 'no employee found with employee_id "%"', v_employee_id;
        ELSIF array_length(v_matches, 1) > 1 THEN
          RAISE EXCEPTION 'employee_id "%" matches % different people — fix the duplicate employee ID before retrying this row',
            v_employee_id, array_length(v_matches, 1);
        END IF;
        v_employee_uuid := v_matches[1];
      ELSIF v_email IS NOT NULL THEN
        SELECT array_agg(user_id) INTO v_matches
        FROM public.profiles
        WHERE organization_id = p_organization_id AND lower(email) = lower(v_email);

        IF v_matches IS NULL OR array_length(v_matches, 1) = 0 THEN
          RAISE EXCEPTION 'no employee found with email "%"', v_email;
        ELSIF array_length(v_matches, 1) > 1 THEN
          RAISE EXCEPTION 'email "%" matches % different people — fix the duplicate email before retrying this row',
            v_email, array_length(v_matches, 1);
        END IF;
        v_employee_uuid := v_matches[1];
      ELSE
        RAISE EXCEPTION 'row has neither employee_id nor email';
      END IF;

      v_submit_result := public.admin_submit_expense_for_employee_v2(
        p_organization_id,
        v_employee_uuid,
        v_row->>'title',
        v_row->>'destination',
        (v_row->>'trip_start')::date,
        (v_row->>'trip_end')::date,
        v_row->>'category',
        (v_row->>'amount')::numeric,
        v_row->>'purpose',
        COALESCE(v_row->'custom_field_values', '[]'::jsonb),
        COALESCE(v_row->>'status', 'submitted'),
        v_row->>'status_comment',
        v_client_op_id
      );

      v_ok_count := v_ok_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_index', v_row_index,
        'ok', true,
        'expense_id', v_submit_result->>'expense_id',
        'idempotent_replay', (v_submit_result->>'idempotent_replay')::boolean
      ));
    EXCEPTION WHEN OTHERS THEN
      v_fail_count := v_fail_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_index', v_row_index,
        'ok', false,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'total', jsonb_array_length(p_rows),
    'succeeded', v_ok_count,
    'failed', v_fail_count,
    'results', v_results
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_bulk_submit_expenses_v2(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_bulk_submit_expenses_v2(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_bulk_submit_expenses_v2(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.admin_bulk_submit_expenses_v2(uuid, jsonb) IS
  'Bulk admin-delegated submission. Loops admin_submit_expense_for_employee_v2 '
  'per row with per-row BEGIN/EXCEPTION isolation so one bad row cannot abort '
  'the batch. Every row requires its own client_operation_id, used as that '
  'row''s idempotency key, so re-submitting the same chunk after a partial '
  'failure or timeout never double-creates a row that already succeeded.';

COMMIT;
