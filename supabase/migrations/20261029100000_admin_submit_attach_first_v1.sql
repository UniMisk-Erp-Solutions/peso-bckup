-- DOC-150 (part 2) -- ADMIN submit-for-employee obeys the bill threshold, attach-first.
--
-- admin_submit_expense_for_employee_v2 inserts the expense directly as 'submitted' and the browser
-- attaches receipts AFTERWARDS, so the bill rule could not be enforced there and
-- 20261028100000 had to skip created_by_admin_id rows. That exemption was an unapproved
-- override. This migration removes it and makes the admin flow attach-first:
--
--   1. admin_prepare_expense_for_employee_v1   draft owned by the employee, created_by_admin_id =
--                                              the admin, logical identity = (org, employee, key);
--                                              a retry returns the SAME row.
--   2. (browser) attach receipts to that draft.
--   3. admin_submit_expense_for_employee_v3    identical to v2 (routing, balance, audit, notifications,
--                                              verify/approve, idempotency table are unchanged) except it
--                                              can PROMOTE the prepared draft (p_existing_expense_id)
--                                              instead of inserting, and validates the bill rule
--                                              immediately. Without a prepared draft an above-threshold
--                                              amount is refused (a bulk import fails only that row).
--   4. admin_bulk_submit_expenses_v3           calls v3 (per-row failure, no whole-batch rollback).
--
-- v2 / bulk v2 stay in place untouched; once the trigger exemption is gone they refuse an
-- above-threshold amount at commit, so a stale browser cannot bypass the rule.

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_validate_expense_attachment_requirement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'submitted'
     AND NOT public.is_organization_locked_for_restore_v1(NEW.organization_id) THEN
    PERFORM public.validate_expense_attachment_requirement_v1(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_prepare_expense_for_employee_v1(
  p_organization_id uuid, p_employee_id uuid,
  p_title text, p_destination text, p_trip_start date, p_trip_end date,
  p_category text, p_amount numeric, p_purpose text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_admin_id uuid := auth.uid();
  v_role     text;
  e          public.expenses%ROWTYPE;
  v_new      uuid;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL OR p_employee_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'organization, employee and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  IF p_employee_id = v_admin_id THEN
    RAISE EXCEPTION 'Use the regular Add Expense page to submit your own expenses' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE user_id = v_admin_id AND organization_id = p_organization_id AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'not permitted: caller is not an active admin of this organization' USING ERRCODE = '42501';
  END IF;
  SELECT role::text INTO v_role FROM public.organization_memberships
  WHERE user_id = p_employee_id AND organization_id = p_organization_id AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'employee is not an active member of this organization' USING ERRCODE = '22023';
  END IF;
  IF public.is_accountant_cashier(p_employee_id, p_organization_id) THEN
    RAISE EXCEPTION 'this employee is an accountant-cashier and cannot have expenses submitted' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_title, '')) = '' OR btrim(COALESCE(p_destination, '')) = '' THEN
    RAISE EXCEPTION 'title and destination are required' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be greater than zero' USING ERRCODE = '22023';
  END IF;

  -- One prepared draft per (organization, employee, key): the same unique index that gives every
  -- other flow its logical identity. A retry (reload, lost response) returns the SAME row.
  SELECT * INTO e FROM public.expenses
  WHERE organization_id = p_organization_id AND user_id = p_employee_id AND client_submission_id = p_idempotency_key;
  IF FOUND THEN
    IF e.created_by_admin_id IS DISTINCT FROM v_admin_id THEN
      RAISE EXCEPTION 'that key belongs to a different submission' USING ERRCODE = '23505';
    END IF;
    IF e.status = 'draft' AND e.deleted_at IS NULL THEN
      UPDATE public.expenses SET title = p_title, destination = p_destination, trip_start = p_trip_start,
        trip_end = p_trip_end, purpose = p_purpose, category = p_category, total_amount = p_amount, updated_at = now()
      WHERE id = e.id;
    END IF;
    RETURN jsonb_build_object('expense_id', e.id, 'status', e.status, 'created', false, 'idempotent_replay', true);
  END IF;

  INSERT INTO public.expenses (
    user_id, organization_id, client_submission_id, title, destination, trip_start, trip_end,
    purpose, category, total_amount, status, created_by_admin_id
  ) VALUES (
    p_employee_id, p_organization_id, p_idempotency_key, p_title, p_destination, p_trip_start, p_trip_end,
    p_purpose, p_category, p_amount, 'draft', v_admin_id
  )
  ON CONFLICT (organization_id, user_id, client_submission_id) WHERE client_submission_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_new;

  IF v_new IS NOT NULL THEN
    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (v_new, v_admin_id, p_organization_id, 'expense_created', 'Draft prepared by admin on behalf of the employee (receipts are attached before submission)');
  END IF;

  SELECT * INTO e FROM public.expenses
  WHERE organization_id = p_organization_id AND user_id = p_employee_id AND client_submission_id = p_idempotency_key;
  RETURN jsonb_build_object('expense_id', e.id, 'status', e.status, 'created', v_new IS NOT NULL, 'idempotent_replay', v_new IS NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_submit_expense_for_employee_v3(p_organization_id uuid, p_employee_id uuid, p_title text, p_destination text, p_trip_start date, p_trip_end date, p_category text, p_amount numeric, p_purpose text DEFAULT NULL::text, p_custom_field_values jsonb DEFAULT '[]'::jsonb, p_status text DEFAULT 'submitted'::text, p_status_comment text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_existing_expense_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF p_existing_expense_id IS NULL THEN
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
  ELSE
    -- ATTACH-FIRST (DOC-150): promote the draft this admin prepared for this employee
    -- (admin_prepare_expense_for_employee_v1), after its bill has been attached.
    PERFORM 1 FROM public.expenses x
    WHERE x.id = p_existing_expense_id
      AND x.organization_id = p_organization_id
      AND x.user_id = p_employee_id
      AND x.created_by_admin_id = v_admin_id
      AND x.status = 'draft'
      AND x.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the prepared draft was not found, is not yours, or is no longer a draft' USING ERRCODE = '22023';
    END IF;
    UPDATE public.expenses SET
      title = p_title, destination = p_destination, trip_start = p_trip_start, trip_end = p_trip_end,
      purpose = p_purpose, category = p_category, total_amount = p_amount,
      status = 'submitted',
      approval_tier = v_approval_tier, assigned_reviewer_id = v_assigned_reviewer, assigned_engineer_id = v_assigned_engineer,
      updated_at = now()
    WHERE id = p_existing_expense_id
    RETURNING id INTO v_expense_id;
  END IF;
  v_final_status := 'submitted';

  ----------------------------------------------------------------------------
  -- DOC-150: the bill rule is checked NOW, inside this call, so a refusal rolls back only this
  -- call (a bulk import then fails just this row) instead of surfacing at COMMIT. The deferred
  -- constraint trigger on expenses re-checks the same rule at commit.
  ----------------------------------------------------------------------------
  PERFORM public.validate_expense_attachment_requirement_v1(v_expense_id);

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
  IF p_existing_expense_id IS NULL THEN
    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (
      v_expense_id, v_admin_id, p_organization_id, 'expense_created',
      format('Expense created by admin %s on behalf of %s', v_admin_name, v_employee_name)
    );
  END IF;
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_bulk_submit_expenses_v3(p_organization_id uuid, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

      v_submit_result := public.admin_submit_expense_for_employee_v3(
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
$function$;

REVOKE ALL ON FUNCTION public.admin_prepare_expense_for_employee_v1(uuid, uuid, text, text, date, date, text, numeric, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_prepare_expense_for_employee_v1(uuid, uuid, text, text, date, date, text, numeric, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_prepare_expense_for_employee_v1(uuid, uuid, text, text, date, date, text, numeric, text, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_submit_expense_for_employee_v3(uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_submit_expense_for_employee_v3(uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_submit_expense_for_employee_v3(uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_bulk_submit_expenses_v3(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_bulk_submit_expenses_v3(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_bulk_submit_expenses_v3(uuid, jsonb) TO authenticated, service_role;

DO $verify$
BEGIN
  IF to_regprocedure('public.admin_prepare_expense_for_employee_v1(uuid, uuid, text, text, date, date, text, numeric, text, uuid)') IS NULL
     OR to_regprocedure('public.admin_submit_expense_for_employee_v3(uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text, uuid)') IS NULL
     OR to_regprocedure('public.admin_bulk_submit_expenses_v3(uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'admin attach-first RPCs missing';
  END IF;
  IF has_function_privilege('anon', 'public.admin_submit_expense_for_employee_v3(uuid, uuid, text, text, date, date, text, numeric, text, jsonb, text, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute admin submit';
  END IF;
END
$verify$;

COMMIT;
