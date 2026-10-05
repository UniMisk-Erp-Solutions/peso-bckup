-- Acceptance tests for apply_singular_expense_correction's baseline-aware
-- no-regression validation (20260909200000_singular_expense_correction_rpc.sql).
--
-- Run manually against a throwaway restore of Production, never against
-- Production itself: this reads real MicroLink fixture data (employee 6818's
-- org, a real project configuration) the same way
-- microlink_atomic_submission_v1_acceptance.sql does.
--
--   psql "$THROWAWAY_DB_URL" -f supabase/tests/singular_expense_correction_acceptance.sql
--
-- Everything runs inside one rolled-back transaction; nothing persists.

\set ON_ERROR_STOP 1
\pset format aligned
\pset border 2
\pset pager off

BEGIN;
-- 20260909200000 is fully self-contained (table/trigger/baseline/RPC), with
-- the historical 290707_2000's stale 'manager' role literal corrected. It
-- supersedes 290707_2000, which must NOT also be sourced here -- it fails
-- outright against the current app_role enum (see the hotfix migration's own
-- header for the full incident writeup).
\i supabase/migrations/20260909200000_singular_expense_correction_rpc.sql

\echo ''
\echo '################ SINGULAR CORRECTION ACCEPTANCE (rolled back) ################'

DO $$
DECLARE
  v_org uuid := '6709c1fe-e8c8-404d-bc68-d1edda923344';
  v_reviewer uuid;
  v_employee uuid;
  v_unrelated uuid;
  v_cross_org_admin uuid;
  v_ms_org uuid := 'e0e9c7a9-555f-448a-8ba2-10fae8e0bf64';
  v_project_uid_tmpl uuid;
  v_from_tmpl uuid;
  v_to_tmpl uuid;
  v_uid_a text; v_uid_b text;
  r jsonb;
  v_expense uuid;
  v_g_expense uuid;
  v_h_expense uuid;
  v_txn text;
  v_fields_before int; v_fields_after int;
BEGIN
  v_project_uid_tmpl := public._microlink_template_id_v1('Project Unique ID');
  v_from_tmpl := public._microlink_template_id_v1('From location');
  v_to_tmpl := public._microlink_template_id_v1('To location');

  SELECT p.user_id::text INTO v_employee FROM public.profiles p
  WHERE p.organization_id = v_org AND p.employee_id = '6818' LIMIT 1;

  SELECT b.parent_option_value INTO v_uid_a
  FROM public.expense_form_field_option_branches b
  WHERE b.organization_id = v_org AND b.parent_template_id = v_project_uid_tmpl AND b.retired_at IS NULL
  GROUP BY 1
  HAVING count(*) FILTER (WHERE b.field_key = 'project_id') = 1
     AND count(*) FILTER (WHERE b.field_key = 'project_name') = 1
     AND bool_and(jsonb_array_length(COALESCE(b.options, '[]'::jsonb)) = 1)
  ORDER BY 1 LIMIT 1;

  -- ── fixture: a real submitted MicroLink expense with an engineer-tier reviewer ──
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', v_employee, 'role', 'authenticated')::text, true) INTO r;
  r := public.submit_microlink_expense_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'core', jsonb_build_object('title', 'acceptance fixture', 'destination', 'X',
      'trip_start', '2026-09-10', 'category', 'Travelling (Public and Private Transport)',
      'total_amount', 50),
    'microlink', jsonb_build_object('project_unique_id', v_uid_a,
      'from_location', 'Ahmedabad', 'to_location', 'Gandhinagar')));
  v_expense := (r->>'expense_id')::uuid;
  v_txn := r->>'transaction_number';
  SELECT assigned_reviewer_id INTO v_reviewer FROM public.expenses WHERE id = v_expense;

  SELECT p.user_id INTO v_unrelated FROM public.profiles p
  WHERE p.organization_id = v_org AND p.user_id NOT IN (v_employee, v_reviewer) LIMIT 1;
  SELECT om.user_id INTO v_cross_org_admin FROM public.organization_memberships om
  WHERE om.organization_id = v_ms_org AND om.role = 'admin' AND om.is_active LIMIT 1;

  RAISE NOTICE '--- AUTH MATRIX ---';
  SELECT set_config('request.jwt.claims', json_build_object('sub', v_unrelated, 'role', 'authenticated')::text, true) INTO r;
  BEGIN
    r := public.apply_singular_expense_correction(v_expense, v_org, jsonb_build_object('title', 'x'), 'auth', '[]'::jsonb);
    RAISE NOTICE '  unrelated employee: ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN RAISE NOTICE '  unrelated employee: REJECTED  %', left(SQLERRM, 60); END;

  SELECT set_config('request.jwt.claims', json_build_object('sub', v_employee, 'role', 'authenticated')::text, true) INTO r;
  BEGIN
    r := public.apply_singular_expense_correction(v_expense, v_org, jsonb_build_object('title', 'x'), 'auth', '[]'::jsonb);
    RAISE NOTICE '  expense owner: ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN RAISE NOTICE '  expense owner: REJECTED  %', left(SQLERRM, 60); END;

  SELECT set_config('request.jwt.claims', json_build_object('sub', v_cross_org_admin, 'role', 'authenticated')::text, true) INTO r;
  BEGIN
    r := public.apply_singular_expense_correction(v_expense, v_org, jsonb_build_object('title', 'x'), 'auth', '[]'::jsonb);
    RAISE NOTICE '  cross-org admin: ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN RAISE NOTICE '  cross-org admin: REJECTED  %', left(SQLERRM, 60); END;

  RAISE NOTICE '  anon EXECUTE: %  (must be f)', has_function_privilege('anon', 'public.apply_singular_expense_correction(uuid,uuid,jsonb,text,jsonb)', 'EXECUTE');
  RAISE NOTICE '  authenticated EXECUTE: %  (must be t)', has_function_privilege('authenticated', 'public.apply_singular_expense_correction(uuid,uuid,jsonb,text,jsonb)', 'EXECUTE');

  RAISE NOTICE '--- HAR-SHAPED CORRECTION (base + custom, by the assigned reviewer) ---';
  SELECT set_config('request.jwt.claims', json_build_object('sub', v_reviewer, 'role', 'authenticated')::text, true) INTO r;
  r := public.apply_singular_expense_correction(v_expense, v_org,
    jsonb_build_object('title', 'acceptance fixture (corrected)', 'total_amount', 51),
    'HAR-shaped correction', jsonb_build_array(
      jsonb_build_object('template_id', v_project_uid_tmpl, 'branch_field_id', null,
        'operation', 'set', 'old_value', v_uid_a, 'new_value', v_uid_a)));
  RAISE NOTICE '  result: %', r;
  RAISE NOTICE '  status=edited: %   txn preserved: %',
    (SELECT status FROM public.expenses WHERE id = v_expense) = 'edited',
    (SELECT transaction_number FROM public.expenses WHERE id = v_expense) = v_txn;

  RAISE NOTICE '--- LEGACY GRANDFATHERING: strip a currently-required field must REJECT with full rollback ---';
  SELECT count(*) INTO v_fields_before FROM public.expense_form_field_values WHERE expense_id = v_expense;
  BEGIN
    r := public.apply_singular_expense_correction(v_expense, v_org, jsonb_build_object('admin_comment', 'x'),
      'strip UID', jsonb_build_array(jsonb_build_object('template_id', v_project_uid_tmpl,
        'branch_field_id', null, 'operation', 'clear', 'old_value', v_uid_a, 'new_value', null)));
    RAISE NOTICE '  strip Project UID: ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN RAISE NOTICE '  strip Project UID: REJECTED (full rollback)  %', left(SQLERRM, 90); END;
  SELECT count(*) INTO v_fields_after FROM public.expense_form_field_values WHERE expense_id = v_expense;
  RAISE NOTICE '  field rows unchanged: %  (before=% after=%)', v_fields_before = v_fields_after, v_fields_before, v_fields_after;

  RAISE NOTICE '--- CATEGORY DEPENDENCY: activating a new requirement without satisfying it must REJECT ---';
  BEGIN
    r := public.apply_singular_expense_correction(v_expense, v_org, jsonb_build_object('admin_comment', 'x'),
      'clear From under a category that requires it',
      jsonb_build_array(jsonb_build_object('template_id', v_from_tmpl, 'branch_field_id', null,
        'operation', 'clear', 'old_value', 'Ahmedabad', 'new_value', null)));
    RAISE NOTICE '  clear From (Travelling requires it): ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN RAISE NOTICE '  clear From (Travelling requires it): REJECTED  %', left(SQLERRM, 90); END;

  BEGIN
    r := public.apply_singular_expense_correction(v_expense, v_org, jsonb_build_object('admin_comment', 'x'),
      'clear and resupply From atomically',
      jsonb_build_array(jsonb_build_object('template_id', v_from_tmpl, 'branch_field_id', null,
        'operation', 'set', 'old_value', 'Ahmedabad', 'new_value', 'Ranchi')));
    RAISE NOTICE '  resupply From: ACCEPTED (expected)  %', r;
  EXCEPTION WHEN others THEN RAISE NOTICE '  resupply From: REJECTED  <-- unexpected  %', left(SQLERRM, 90); END;

  RAISE NOTICE '--- PROJECT UID DEPENDENCY: changing UID without valid dependents must REJECT, with valid dependents PASSES ---';
  SELECT min(q.x), max(q.x) INTO v_uid_a, v_uid_b FROM (
    SELECT b.parent_option_value AS x FROM public.expense_form_field_option_branches b
    WHERE b.organization_id = v_org AND b.parent_template_id = v_project_uid_tmpl AND b.retired_at IS NULL
    GROUP BY 1
    HAVING count(*) FILTER (WHERE b.field_key = 'project_id') = 1
       AND count(*) FILTER (WHERE b.field_key = 'project_name') = 1
       AND bool_and(jsonb_array_length(COALESCE(b.options, '[]'::jsonb)) = 1)
    LIMIT 2) q;

  SELECT set_config('request.jwt.claims', json_build_object('sub', v_employee, 'role', 'authenticated')::text, true) INTO r;
  r := public.submit_microlink_expense_v1(jsonb_build_object(
    'idempotency_key', gen_random_uuid()::text,
    'core', jsonb_build_object('title', 'UID dependency fixture', 'destination', 'X', 'trip_start', '2026-09-10',
      'category', 'Food', 'total_amount', 10),
    'microlink', jsonb_build_object('project_unique_id', v_uid_a, 'from_location', 'A', 'to_location', 'B')));
  v_h_expense := (r->>'expense_id')::uuid;

  SELECT set_config('request.jwt.claims', json_build_object('sub', v_reviewer, 'role', 'authenticated')::text, true) INTO r;
  BEGIN
    r := public.apply_singular_expense_correction(v_h_expense, v_org, jsonb_build_object('admin_comment', 'x'),
      'UID changed, stale dependents',
      jsonb_build_array(jsonb_build_object('template_id', v_project_uid_tmpl, 'branch_field_id', null,
        'operation', 'set', 'old_value', v_uid_a, 'new_value', v_uid_b)));
    RAISE NOTICE '  UID change with stale dependents: ACCEPTED  <-- WRONG';
  EXCEPTION WHEN others THEN RAISE NOTICE '  UID change with stale dependents: REJECTED  %', left(SQLERRM, 90); END;

  DECLARE
    v_pid_val text; v_pname_val text; v_pid_branch uuid; v_pname_branch uuid;
  BEGIN
    SELECT b.options->>0, b.id INTO v_pid_val, v_pid_branch FROM public.expense_form_field_option_branches b
     WHERE b.organization_id = v_org AND b.parent_option_value = v_uid_b AND b.field_key = 'project_id' AND b.retired_at IS NULL;
    SELECT b.options->>0, b.id INTO v_pname_val, v_pname_branch FROM public.expense_form_field_option_branches b
     WHERE b.organization_id = v_org AND b.parent_option_value = v_uid_b AND b.field_key = 'project_name' AND b.retired_at IS NULL;
    BEGIN
      r := public.apply_singular_expense_correction(v_h_expense, v_org, jsonb_build_object('admin_comment', 'x'),
        'UID changed with correct dependents',
        jsonb_build_array(
          jsonb_build_object('template_id', v_project_uid_tmpl, 'branch_field_id', null,
            'operation', 'set', 'old_value', v_uid_a, 'new_value', v_uid_b),
          jsonb_build_object('template_id', null, 'branch_field_id', v_pid_branch,
            'operation', 'set', 'old_value', null, 'new_value', v_pid_val),
          jsonb_build_object('template_id', null, 'branch_field_id', v_pname_branch,
            'operation', 'set', 'old_value', null, 'new_value', v_pname_val)));
      RAISE NOTICE '  UID change with valid dependents: ACCEPTED (expected)  %', r;
    EXCEPTION WHEN others THEN
      RAISE NOTICE '  UID change with valid dependents: REJECTED  <-- unexpected  %', left(SQLERRM, 120);
    END;
  END;

  RAISE NOTICE '--- STATUS BOUNDARIES ---';
  DECLARE v_draft uuid; v_approved uuid;
  BEGIN
    SELECT id INTO v_draft FROM public.expenses WHERE organization_id = v_org AND status = 'draft' LIMIT 1;
    SELECT id INTO v_approved FROM public.expenses WHERE organization_id = v_org AND status = 'approved' LIMIT 1;
    IF v_draft IS NOT NULL THEN
      BEGIN
        r := public.apply_singular_expense_correction(v_draft, v_org, jsonb_build_object('admin_comment', 'x'), 'boundary', '[]'::jsonb);
        RAISE NOTICE '  draft: ACCEPTED  <-- WRONG';
      EXCEPTION WHEN others THEN RAISE NOTICE '  draft: REJECTED  %', left(SQLERRM, 60); END;
    END IF;
    IF v_approved IS NOT NULL THEN
      BEGIN
        r := public.apply_singular_expense_correction(v_approved, v_org, jsonb_build_object('admin_comment', 'x'), 'boundary', '[]'::jsonb);
        RAISE NOTICE '  approved: ACCEPTED  <-- WRONG';
      EXCEPTION WHEN others THEN RAISE NOTICE '  approved: REJECTED  %', left(SQLERRM, 60); END;
    END IF;
  END;
END $$;

\echo ''
\echo '################ ROLLING BACK — production untouched ################'
ROLLBACK;
