-- MicroLink V1 data-safety hotfix: `_persist_microlink_expense_snapshot_v1`'s
-- Project Unique ID cleanup DELETE could destroy a historical Project
-- ID/Project Name value once the branch backing it was retired.
--
-- Root cause: `_microlink_resolve_project_fields_v1` excludes retired
-- branches (`AND b.retired_at IS NULL`), so once a project's id/name branch
-- is retired, it resolves to NULL for that field. The cleanup DELETE below
-- then removed every branch value under the Project Unique ID tree that
-- wasn't exactly the currently-resolved project_id_branch/project_name_branch
-- -- including a retired branch's own historical row, since NULL is
-- "distinct from" any real branch id. Reproduced and proven in a rolled-back
-- transaction against a real Production expense during the DOC-096
-- Milestone 1B recovery review, before writing this migration: retiring the
-- expense's own project_id branch and re-running the unmodified cleanup
-- DELETE removed its historical value (DELETE 1); the same scenario with
-- this fix's predicate added left it untouched (DELETE 0); an explicit
-- project-to-project switch (branch NOT retired, resolver returns a
-- different branch pair) still correctly cleaned up the old project's
-- values (DELETE 2, unchanged from current behavior).
--
-- Fix: exclude retired branches from the cleanup DELETE's join, so a
-- historical value tied to a since-retired branch is never swept, while an
-- employee's explicit switch to a different (still-active) project still
-- cleans up the previous project's now-obsolete active branch values
-- exactly as before. Retirement status is itself the correct signal for
-- "the value became hidden because configuration changed, not because the
-- user changed their answer" -- no new "user intent" tracking is needed for
-- this narrow case.
--
-- This is the CURRENT live function body (verified fresh immediately before
-- writing this migration) with exactly that one predicate added -- no other
-- line changed. SECURITY DEFINER, search_path, signature, and ACL
-- (anon=false, authenticated=false, service_role=true -- this is an
-- internal-only helper, never called directly by a client) are all
-- preserved automatically by CREATE OR REPLACE FUNCTION on an identical
-- signature; verified unchanged after apply.

CREATE OR REPLACE FUNCTION public._persist_microlink_expense_snapshot_v1(p_snapshot jsonb, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org        uuid := public._microlink_organization_id_v1();
  v_uid        uuid := auth.uid();
  v_key        uuid;
  v_expense_id uuid;
  v_expected   bigint;
  v_existing   public.expenses%ROWTYPE;
  v_core       jsonb;
  v_ml         jsonb;
  v_receipt    public.expense_submission_receipts%ROWTYPE;
  v_status     text;
  v_tier       text;
  v_reviewer   uuid;
  v_engineer   uuid;
  v_proj       record;
  v_tmpl_uid   uuid;
  v_tmpl_from  uuid;
  v_tmpl_to    uuid;
  v_field_n    integer;
  v_row        jsonb;
BEGIN
  IF p_action NOT IN ('submit','save_draft','update_submitted') THEN
    RAISE EXCEPTION 'invalid action %', p_action USING ERRCODE = '22023';
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  v_key := NULLIF(p_snapshot->>'idempotency_key','')::uuid;
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_receipt FROM public.expense_submission_receipts
  WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF v_receipt.user_id <> v_uid THEN
      RAISE EXCEPTION 'idempotency key belongs to another user' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
      'committed', true, 'replayed', true,
      'expense_id', v_receipt.expense_id,
      'transaction_number', v_receipt.transaction_number,
      'status', v_receipt.status,
      'revision', v_receipt.revision,
      'submitted_at', v_receipt.committed_at,
      'snapshot_hash', v_receipt.snapshot_hash,
      'persisted_core_fields', v_receipt.core_field_count,
      'persisted_custom_fields', v_receipt.custom_field_count,
      'idempotency_key', v_receipt.idempotency_key);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid AND om.organization_id = v_org AND om.is_active
  ) THEN
    RAISE EXCEPTION 'This expense endpoint is not available for your organization.'
      USING ERRCODE = '42501';
  END IF;

  v_core  := COALESCE(p_snapshot->'core', '{}'::jsonb);
  v_ml    := COALESCE(p_snapshot->'microlink', '{}'::jsonb);
  v_expense_id := NULLIF(p_snapshot->>'expense_id','')::uuid;
  v_expected   := NULLIF(p_snapshot->>'expected_revision','')::bigint;

  IF p_action = 'update_submitted' AND v_expense_id IS NULL THEN
    RAISE EXCEPTION 'update_submitted requires an existing expense_id' USING ERRCODE = '22023';
  END IF;

  IF v_expense_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.expenses WHERE id = v_expense_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_existing.organization_id <> v_org THEN
      RAISE EXCEPTION 'Expense belongs to another organization' USING ERRCODE = '42501';
    END IF;
    IF v_existing.user_id <> v_uid THEN
      RAISE EXCEPTION 'You do not own this expense' USING ERRCODE = '42501';
    END IF;

    IF p_action = 'update_submitted' THEN
      IF v_existing.status::text <> 'submitted' THEN
        RAISE EXCEPTION 'This expense can no longer be edited (status %).', v_existing.status
          USING ERRCODE = '22023';
      END IF;
    ELSE
      IF v_existing.status::text NOT IN ('draft','rejected') THEN
        RAISE EXCEPTION 'This expense can no longer be edited (status %).', v_existing.status
          USING ERRCODE = '22023';
      END IF;
    END IF;

    IF v_expected IS NOT NULL AND COALESCE(v_existing.revision,0) <> v_expected THEN
      RAISE EXCEPTION 'This expense changed in another session. Reload before submitting.'
        USING ERRCODE = 'PW409';
    END IF;
  END IF;

  v_tmpl_uid  := public._microlink_template_id_v1('Project Unique ID');
  v_tmpl_from := public._microlink_template_id_v1('From location');
  v_tmpl_to   := public._microlink_template_id_v1('To location');

  SELECT * INTO v_proj FROM public._microlink_resolve_project_fields_v1(
    v_ml->>'project_unique_id', v_ml->>'project_id', v_ml->>'project_name');

  v_status := CASE WHEN p_action = 'submit' THEN 'submitted' ELSE 'draft' END;

  IF p_action = 'submit' THEN
    SELECT r.approval_tier, r.assigned_reviewer_id, r.assigned_engineer_id
      INTO v_tier, v_reviewer, v_engineer
    FROM public._expense_resolve_routing_v1(v_org, v_uid) r;
  END IF;

  IF v_expense_id IS NULL THEN
    INSERT INTO public.expenses (
      user_id, organization_id, title, destination, trip_start, trip_end,
      purpose, category, total_amount, status, approval_tier,
      assigned_reviewer_id, assigned_engineer_id
    ) VALUES (
      v_uid, v_org,
      v_core->>'title', v_core->>'destination',
      (v_core->>'trip_start')::date,
      COALESCE((v_core->>'trip_end')::date, (v_core->>'trip_start')::date),
      v_core->>'purpose', v_core->>'category',
      (v_core->>'total_amount')::numeric,
      v_status::public.expense_status, v_tier, v_reviewer, v_engineer
    ) RETURNING id INTO v_expense_id;
  ELSE
    UPDATE public.expenses SET
      title = v_core->>'title',
      destination = v_core->>'destination',
      trip_start = (v_core->>'trip_start')::date,
      trip_end = COALESCE((v_core->>'trip_end')::date, (v_core->>'trip_start')::date),
      purpose = v_core->>'purpose',
      category = v_core->>'category',
      total_amount = (v_core->>'total_amount')::numeric,
      status = CASE WHEN p_action = 'submit'
                    THEN v_status::public.expense_status ELSE status END,
      approval_tier = CASE WHEN p_action = 'submit' THEN v_tier ELSE approval_tier END,
      assigned_reviewer_id = CASE WHEN p_action = 'submit' THEN v_reviewer ELSE assigned_reviewer_id END,
      assigned_engineer_id = CASE WHEN p_action = 'submit' THEN v_engineer ELSE assigned_engineer_id END,
      updated_at = now()
    WHERE id = v_expense_id;
  END IF;

  PERFORM public._microlink_upsert_template_value_v1(
    v_expense_id, v_tmpl_uid, v_ml->>'project_unique_id');
  PERFORM public._microlink_upsert_template_value_v1(
    v_expense_id, v_tmpl_from, v_ml->>'from_location');
  PERFORM public._microlink_upsert_template_value_v1(
    v_expense_id, v_tmpl_to, v_ml->>'to_location');

  IF v_proj.project_id_branch IS NOT NULL THEN
    PERFORM public._microlink_upsert_branch_value_v1(
      v_expense_id, v_proj.project_id_branch, v_proj.project_id_value);
  END IF;
  IF v_proj.project_name_branch IS NOT NULL THEN
    PERFORM public._microlink_upsert_branch_value_v1(
      v_expense_id, v_proj.project_name_branch, v_proj.project_name_value);
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(
      COALESCE(p_snapshot->'additional_fields','[]'::jsonb))
  LOOP
    PERFORM public._microlink_upsert_template_value_v1(
      v_expense_id, (v_row->>'template_id')::uuid, v_row->>'value');
  END LOOP;

  -- Branch rows belonging to a project the employee is no longer on. Scoped
  -- to THIS expense and THIS parent template only, so an absent key can
  -- never delete anything outside the scope the snapshot actually covers.
  -- `AND b.retired_at IS NULL` is the fix: a RETIRED branch's historical
  -- value must never be swept here just because the resolver (which itself
  -- excludes retired branches) can no longer name it as the current
  -- project_id_branch/project_name_branch -- retirement is a configuration
  -- change, not a user decision to discard the answer. An explicit
  -- project-to-project switch is unaffected: the old (still-active)
  -- project's branch values remain eligible for this cleanup exactly as
  -- before, since only rows with `retired_at IS NULL` are ever considered.
  DELETE FROM public.expense_form_field_values v
  USING public.expense_form_field_option_branches b
  WHERE v.expense_id = v_expense_id
    AND v.branch_field_id = b.id
    AND b.parent_template_id = v_tmpl_uid
    AND b.retired_at IS NULL
    AND v.branch_field_id IS DISTINCT FROM v_proj.project_id_branch
    AND v.branch_field_id IS DISTINCT FROM v_proj.project_name_branch;

  IF p_action IN ('submit','update_submitted') THEN
    PERFORM public.validate_expense_submission_invariants_v1(v_expense_id);
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
  END IF;

  SELECT count(*) INTO v_field_n
  FROM public.expense_form_field_values WHERE expense_id = v_expense_id;

  SELECT * INTO v_existing FROM public.expenses WHERE id = v_expense_id;

  IF p_action = 'submit' THEN
    IF v_existing.status::text <> 'submitted' THEN
      RAISE EXCEPTION 'submission did not reach the submitted state' USING ERRCODE = 'PW500';
    END IF;
    IF v_existing.transaction_number IS NULL THEN
      RAISE EXCEPTION 'submission reached submitted without a transaction number'
        USING ERRCODE = 'PW500';
    END IF;

    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (v_expense_id, v_uid, v_org, 'expense_submitted',
            'Submitted via atomic snapshot V1');

  ELSIF p_action = 'update_submitted' THEN
    IF v_existing.status::text <> 'submitted' THEN
      RAISE EXCEPTION 'update did not preserve the submitted state' USING ERRCODE = 'PW500';
    END IF;
    IF v_existing.transaction_number IS NULL THEN
      RAISE EXCEPTION 'submitted expense lost its transaction number' USING ERRCODE = 'PW500';
    END IF;

    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (v_expense_id, v_uid, v_org, 'expense_updated',
            'Updated via atomic snapshot V1');
  END IF;

  INSERT INTO public.expense_submission_receipts (
    idempotency_key, organization_id, user_id, expense_id, action,
    transaction_number, status, revision, snapshot_hash,
    core_field_count, custom_field_count)
  VALUES (
    v_key, v_org, v_uid, v_expense_id, p_action,
    v_existing.transaction_number, v_existing.status::text,
    COALESCE(v_existing.revision,0),
    public._expense_snapshot_hash_v1(v_expense_id),
    (SELECT count(*) FROM jsonb_object_keys(v_core)), v_field_n);

  RETURN jsonb_build_object(
    'committed', true, 'replayed', false,
    'expense_id', v_expense_id,
    'transaction_number', v_existing.transaction_number,
    'status', v_existing.status::text,
    'revision', COALESCE(v_existing.revision,0),
    'submitted_at', now(),
    'snapshot_hash', public._expense_snapshot_hash_v1(v_expense_id),
    'persisted_core_fields', (SELECT count(*) FROM jsonb_object_keys(v_core)),
    'persisted_custom_fields', v_field_n,
    'idempotency_key', v_key);
END;
$function$;
