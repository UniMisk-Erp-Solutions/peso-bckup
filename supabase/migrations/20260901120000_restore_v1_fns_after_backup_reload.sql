-- Restore the v1 RPCs the DEPLOYED frontend calls, lost in the 2026-09-01
-- backup reload (DOC-116 section 10b).
--
-- ============================================================================
-- STATUS: applied to peso-bckup on 2026-09-01. NOT applied to Production.
-- ============================================================================
--
-- The dump loaded into the backup instance came from a NEWER codebase than the
-- frontend deployed at peso-backup.vercel.app (which builds from this repo).
-- That newer schema replaced these three functions with _v2 variants. No _v2
-- name appears anywhere in src/, so the deployed app called functions that no
-- longer existed and those pages broke.
--
-- These definitions are recovered VERBATIM from the pre-restore backup rather
-- than rewritten as wrappers over the _v2 functions: the _v2 signatures differ
-- (get_daily_report_project_name_ambiguity_batch_v2 takes an explicit
-- p_project_ids array instead of scanning the org), and guessing at upstream
-- semantics is how a subtle data bug gets introduced. They coexist with the
-- _v2 functions; nothing is replaced or dropped.
--
-- The four generated-report functions lost in the same reload are NOT here --
-- their backing table was dropped upstream too, so they are restored by
-- re-applying this repo's own 20260823100000_generated_report_snapshots.sql,
-- which is idempotent and recreates the tables, policies and functions.
--
-- This is a compatibility bridge. The real fix is to move the frontend onto
-- the _v2 API; until then the deployed build needs these.
-- ---------------------------------------------------------------------------

-- v1 report/admin functions the DEPLOYED frontend calls, lost in the
-- 2026-09-01 restore. Recovered verbatim from the pre-restore backup.
-- They coexist with the newer v2 functions; nothing is replaced.

-- ---------- admin_submit_expense_for_employee_v1 ----------
CREATE FUNCTION "public"."admin_submit_expense_for_employee_v1"("p_organization_id" "uuid", "p_employee_id" "uuid", "p_title" "text", "p_destination" "text", "p_trip_start" "date", "p_trip_end" "date", "p_category" "text", "p_amount" numeric, "p_purpose" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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
$$;


-- ---------- admin_bulk_submit_expenses_v1 ----------
CREATE FUNCTION "public"."admin_bulk_submit_expenses_v1"("p_organization_id" "uuid", "p_rows" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_admin_id     uuid := auth.uid();
  v_row          jsonb;
  v_row_index    integer;
  v_employee_id  text;
  v_email        text;
  v_matches      uuid[];
  v_employee_uuid uuid;
  v_submit_result jsonb;
  v_results      jsonb := '[]'::jsonb;
  v_ok_count     integer := 0;
  v_fail_count   integer := 0;
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
  -- Client chunks a large import into groups of 200 (see bulkAdminSubmitExpenses.ts);
  -- this cap is a loud guard against an oversized single call, not the normal path.
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

      -- Delegates entirely to the existing, tested single-row function: same
      -- validation, same hierarchy routing, same audit trail, same notifications.
      v_submit_result := public.admin_submit_expense_for_employee_v1(
        p_organization_id,
        v_employee_uuid,
        v_row->>'title',
        v_row->>'destination',
        (v_row->>'trip_start')::date,
        (v_row->>'trip_end')::date,
        v_row->>'category',
        (v_row->>'amount')::numeric,
        v_row->>'purpose'
      );

      v_ok_count := v_ok_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_index', v_row_index,
        'ok', true,
        'expense_id', v_submit_result->>'expense_id'
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
$$;


-- ---------- get_daily_report_project_name_ambiguity_v1 ----------
CREATE FUNCTION "public"."get_daily_report_project_name_ambiguity_v1"("p_organization_id" "uuid") RETURNS TABLE("project_id" "text", "distinct_name_count" integer)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_cfg      jsonb;
  v_pid_kind text; v_pid_key text; v_pid_uuid uuid;
  v_pnm_kind text; v_pnm_key text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;

  -- Same permission gate as the report itself. Org-wide fact, not
  -- team-scoped -- ambiguity doesn't vary by who is asking.
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, false) THEN
    RAISE EXCEPTION 'not permitted to view this report metadata' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_cfg
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;

  v_cfg := COALESCE(v_cfg, '{}'::jsonb);

  SELECT k, v INTO v_pid_kind, v_pid_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectId}') AS s(k, v);
  SELECT k, v INTO v_pnm_kind, v_pnm_key
  FROM public._daily_report_parse_source_v1(v_cfg #>> '{fieldMappings,projectName}') AS s(k, v);

  IF v_pnm_kind <> 'dynamic' OR v_pid_kind NOT IN ('template', 'branch') THEN
    RETURN; -- empty set: nothing to be ambiguous about under this mapping
  END IF;

  v_pid_uuid := v_pid_key::uuid;

  RETURN QUERY
  SELECT b.parent_option_value,
         COUNT(DISTINCT v.field_value)::integer
  FROM public.expense_form_field_option_branches b
  JOIN public.expense_form_field_values v
    ON v.branch_field_id = b.id AND v.organization_id = b.organization_id
  JOIN public.expenses e ON e.id = v.expense_id AND e.status = 'approved'
  WHERE b.parent_template_id = v_pid_uuid
    AND b.field_key = 'project_name'
    AND b.organization_id = p_organization_id
    AND btrim(COALESCE(v.field_value, '')) <> ''
  GROUP BY b.parent_option_value
  HAVING COUNT(DISTINCT v.field_value) > 1;
END;
$$;


-- ---------- ownership + grants (verbatim from the same backup) ----------
ALTER FUNCTION "public"."admin_bulk_submit_expenses_v1"("p_organization_id" "uuid", "p_rows" "jsonb") OWNER TO "supabase_admin";
ALTER FUNCTION "public"."admin_submit_expense_for_employee_v1"("p_organization_id" "uuid", "p_employee_id" "uuid", "p_title" "text", "p_destination" "text", "p_trip_start" "date", "p_trip_end" "date", "p_category" "text", "p_amount" numeric, "p_purpose" "text") OWNER TO "supabase_admin";
ALTER FUNCTION "public"."get_daily_report_project_name_ambiguity_v1"("p_organization_id" "uuid") OWNER TO "postgres";
GRANT ALL ON FUNCTION "public"."admin_bulk_submit_expenses_v1"("p_organization_id" "uuid", "p_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_submit_expense_for_employee_v1"("p_organization_id" "uuid", "p_employee_id" "uuid", "p_title" "text", "p_destination" "text", "p_trip_start" "date", "p_trip_end" "date", "p_category" "text", "p_amount" numeric, "p_purpose" "text") TO "authenticated";
REVOKE ALL ON FUNCTION "public"."get_daily_report_project_name_ambiguity_v1"("p_organization_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_daily_report_project_name_ambiguity_v1"("p_organization_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_daily_report_project_name_ambiguity_v1"("p_organization_id" "uuid") TO "service_role";

NOTIFY pgrst, 'reload schema';
