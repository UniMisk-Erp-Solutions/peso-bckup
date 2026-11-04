-- MicroLink expense receipts: make idempotency action-scoped (DOC-140).
--
-- INCIDENT. For a new expense that needs a bill, the client saves a draft,
-- attaches the files, then submits -- and used ONE idempotency key for both
-- calls. expense_submission_receipts was keyed by idempotency_key alone and
-- _persist_microlink_expense_snapshot_v1 answered any repeated key with the
-- stored receipt WITHOUT looking at which action wrote it. The submit was
-- therefore answered with the draft's receipt (status 'draft', replayed true),
-- never ran, and the expense stayed a draft while the client reported success.
-- 231 MicroLink expenses in 30 days took that path; 193 needed a manual second
-- submit and 38 were still drafts.
--
-- FIX (server, independent of any client). The identity of a receipt is now
-- (idempotency_key, action):
--   * PRIMARY KEY (idempotency_key, action) -- a draft receipt and a submit
--     receipt for the same raw key can coexist, so an old cached client that
--     reuses one key for both calls gets its submit EXECUTED (once), not a
--     replay of the draft.
--   * the replay lookup is filtered by the requested action; a different
--     action under the same key executes under its own receipt.
--   * the cross-user guard is kept and now covers any action under the key.
--   * every response states requested_action, receipt_action, actual_status
--     and idempotency_result ('executed' | 'replayed') so a client can prove
--     the state it asked for instead of trusting "committed".
--   * get_expense_submission_result_v1 takes an optional action (same scoping);
--     without one it prefers submit > update_submitted > save_draft.
--
-- Body of _persist_microlink_expense_snapshot_v1 is the LIVE Production
-- definition with only the replay block, the declaration of v_actual and the
-- final RETURN changed (no drift from later migrations is lost).
-- Safe to re-run: the PK swap is skipped once it is already composite.

DO $pk$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def
  FROM pg_constraint c
  WHERE c.conrelid = 'public.expense_submission_receipts'::regclass AND c.contype = 'p';
  IF v_def IS DISTINCT FROM 'PRIMARY KEY (idempotency_key, action)' THEN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE confrelid = 'public.expense_submission_receipts'::regclass) THEN
      RAISE EXCEPTION 'a foreign key references expense_submission_receipts; refusing to change its primary key';
    END IF;
    ALTER TABLE public.expense_submission_receipts DROP CONSTRAINT expense_submission_receipts_pkey;
    ALTER TABLE public.expense_submission_receipts
      ADD CONSTRAINT expense_submission_receipts_pkey PRIMARY KEY (idempotency_key, action);
  END IF;
END
$pk$;

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
  v_actual     text;
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

  -- IDEMPOTENCY IDENTITY = (idempotency_key, action). A receipt written for one
  -- action (save_draft) must NEVER answer a different action (submit): that
  -- replayed a draft receipt for a submit request and the submit never ran.
  IF EXISTS (
    SELECT 1 FROM public.expense_submission_receipts r
    WHERE r.idempotency_key = v_key AND r.user_id <> v_uid
  ) THEN
    RAISE EXCEPTION 'idempotency key belongs to another user' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_receipt FROM public.expense_submission_receipts
  WHERE idempotency_key = v_key AND action = p_action;
  IF FOUND THEN
    SELECT e.status::text INTO v_actual FROM public.expenses e WHERE e.id = v_receipt.expense_id;
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
      'idempotency_key', v_receipt.idempotency_key,
      'requested_action', p_action,
      'receipt_action', v_receipt.action,
      'actual_status', COALESCE(v_actual, v_receipt.status),
      'idempotency_result', 'replayed');
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
    'idempotency_key', v_key,
    'requested_action', p_action,
    'receipt_action', p_action,
    'actual_status', v_existing.status::text,
    'idempotency_result', 'executed');
END;
$function$;

-- Reconciliation lookup after an ambiguous transport failure. Scoped by action
-- when the caller says which call it is reconciling.
DROP FUNCTION IF EXISTS public.get_expense_submission_result_v1(uuid);

CREATE OR REPLACE FUNCTION public.get_expense_submission_result_v1(
  p_idempotency_key uuid,
  p_action text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  r        public.expense_submission_receipts%ROWTYPE;
  v_actual text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_action IS NOT NULL AND p_action NOT IN ('submit','save_draft','update_submitted') THEN
    RAISE EXCEPTION 'invalid action %', p_action USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.expense_submission_receipts x
  WHERE x.idempotency_key = p_idempotency_key AND x.user_id = v_uid
    AND (p_action IS NULL OR x.action = p_action)
  ORDER BY CASE x.action WHEN 'submit' THEN 0 WHEN 'update_submitted' THEN 1 ELSE 2 END
  LIMIT 1;
  IF NOT FOUND THEN
    -- Absence is NOT proof of failure while a request may still be in flight;
    -- the client decides using its own elapsed time. We only report what we know.
    RETURN jsonb_build_object('committed', false, 'known', false);
  END IF;
  SELECT e.status::text INTO v_actual FROM public.expenses e WHERE e.id = r.expense_id;
  RETURN jsonb_build_object(
    'committed', true, 'known', true,
    'expense_id', r.expense_id, 'transaction_number', r.transaction_number,
    'status', r.status, 'revision', r.revision, 'submitted_at', r.committed_at,
    'snapshot_hash', r.snapshot_hash, 'idempotency_key', r.idempotency_key,
    'requested_action', COALESCE(p_action, r.action), 'receipt_action', r.action,
    'actual_status', COALESCE(v_actual, r.status),
    'idempotency_result', 'replayed');
END;
$function$;

REVOKE ALL ON FUNCTION public.get_expense_submission_result_v1(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expense_submission_result_v1(uuid, text) TO authenticated, service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.expense_submission_receipts'::regclass AND c.contype = 'p'
      AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (idempotency_key, action)'
  ) THEN
    RAISE EXCEPTION 'receipts primary key is not (idempotency_key, action)';
  END IF;
  IF position('v_receipt.action' IN pg_get_functiondef('public._persist_microlink_expense_snapshot_v1(jsonb,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'replay lookup is not action-scoped';
  END IF;
  RAISE NOTICE 'microlink action-scoped idempotency migration verified OK';
END
$verify$;
