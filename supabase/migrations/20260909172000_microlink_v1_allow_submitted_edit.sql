-- ============================================================================
-- HOTFIX: MicroLink V1 submitted-expense edit regression
--
-- INCIDENT: 2026-09-09 ~17:20 IST. An employee editing their own SUBMITTED
-- expense received "This expense can no longer be edited (status submitted)."
--
-- ROOT CAUSE: _persist_microlink_expense_snapshot_v1 (introduced in
-- 20260909100000_microlink_atomic_submission_v1.sql) gates re-persisting an
-- existing expense on:
--
--     IF v_existing.status::text NOT IN ('draft','rejected') THEN RAISE ...
--
-- which wrongly excludes 'submitted'. The frontend's own eligibility guard
-- (canOwnerEditExpenseStatus, src/lib/expenseEditRules.ts) already allows
-- draft/submitted/rejected; only the database refused it.
--
-- CORRECTION TO THE FIRST DRAFT OF THIS HOTFIX (owner review, 2026-09-09):
-- simply adding 'submitted' to the p_action='submit' allowlist would have
-- made a submitted edit re-run _expense_resolve_routing_v1 and rewrite
-- approval_tier / assigned_reviewer_id / assigned_engineer_id, and insert a
-- second 'expense_submitted' audit row. Verified against the ACTUAL legacy
-- client behavior (src/pages/ExpenseForm.tsx:1909-1933): for an existing
-- expense, ExpenseService.updateExpense() ALWAYS runs, and
-- ExpenseService.submitExpense() is called ONLY when
-- expenseStatus is 'draft' or 'rejected' — never for 'submitted'. So a
-- legacy submitted edit only updates core/custom fields and logs
-- 'expense_updated' (ExpenseService.ts:402); it never re-routes and never
-- logs a second submission event. The original hotfix draft, which is
-- superseded by this migration (never applied to Production), would have
-- been a NEW regression.
--
-- FIX: give the shared atomic engine a THIRD action, 'update_submitted',
-- alongside the existing 'submit' and 'save_draft'. It reuses every piece of
-- the engine (custom-field upserts, branch cleanup, required-field
-- validation, revision bump, idempotency/receipt) and differs from 'submit'
-- only in what it does NOT do:
--   - does not resolve or rewrite routing (approval_tier / assigned_*),
--     because the UPDATE's CASE expressions already only touch those columns
--     WHEN p_action = 'submit' — 'update_submitted' falls through and
--     preserves the existing values with zero code change there.
--   - does not touch status (same reason: the status CASE only fires for
--     'submit').
--   - logs 'expense_updated', not 'expense_submitted'.
-- This is a forward-only migration; it does not edit the already-applied
-- 20260909100000 migration file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Widen the receipts table's action CHECK to admit the new action.
-- ----------------------------------------------------------------------------
ALTER TABLE public.expense_submission_receipts
  DROP CONSTRAINT IF EXISTS expense_submission_receipts_action_check;
ALTER TABLE public.expense_submission_receipts
  ADD CONSTRAINT expense_submission_receipts_action_check
  CHECK (action IN ('submit','save_draft','update_submitted'));

-- ----------------------------------------------------------------------------
-- 2. THE ENGINE — same function, same signature, one more action.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._persist_microlink_expense_snapshot_v1(
  p_snapshot jsonb,
  p_action   text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
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

  ---------------------------------------------------------------------------
  -- IDEMPOTENCY, answered before anything is written, so a retry after a lost
  -- response returns the original receipt instead of creating a second expense.
  ---------------------------------------------------------------------------
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

  ---------------------------------------------------------------------------
  -- AUTHORIZATION. MicroLink only; the caller must be an active member.
  ---------------------------------------------------------------------------
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

  ---------------------------------------------------------------------------
  -- LOCK + OPTIMISTIC CONCURRENCY
  ---------------------------------------------------------------------------
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

    -- Editability is action-specific: 'submit'/'save_draft' move a draft or
    -- rejected expense forward; 'update_submitted' edits an ALREADY submitted
    -- expense in place. Neither action may touch approved/paid/edited rows.
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

  ---------------------------------------------------------------------------
  -- RESOLVE THE MICROLINK SEMANTIC FIELDS. The client never sends uuids.
  ---------------------------------------------------------------------------
  v_tmpl_uid  := public._microlink_template_id_v1('Project Unique ID');
  v_tmpl_from := public._microlink_template_id_v1('From location');
  v_tmpl_to   := public._microlink_template_id_v1('To location');

  SELECT * INTO v_proj FROM public._microlink_resolve_project_fields_v1(
    v_ml->>'project_unique_id', v_ml->>'project_id', v_ml->>'project_name');

  ---------------------------------------------------------------------------
  -- CORE WRITE
  --
  -- The status/routing CASE expressions below fire only for p_action='submit'
  -- BY DESIGN: 'save_draft' must not touch status, and 'update_submitted'
  -- must not touch status, approval_tier, assigned_reviewer_id or
  -- assigned_engineer_id — the whole point of an in-place submitted edit is
  -- that routing already happened and must not silently change because the
  -- reporting hierarchy moved on after the original submission. Those columns
  -- fall through to their existing value on every non-'submit' action.
  ---------------------------------------------------------------------------
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

  ---------------------------------------------------------------------------
  -- CUSTOM FIELD WRITE — same transaction, narrow upserts.
  ---------------------------------------------------------------------------
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

  -- Branch rows belonging to a project the employee is no longer on. Scoped to
  -- THIS expense and THIS parent template only, so an absent key can never
  -- delete anything outside the scope the snapshot actually covers.
  DELETE FROM public.expense_form_field_values v
  USING public.expense_form_field_option_branches b
  WHERE v.expense_id = v_expense_id
    AND v.branch_field_id = b.id
    AND b.parent_template_id = v_tmpl_uid
    AND v.branch_field_id IS DISTINCT FROM v_proj.project_id_branch
    AND v.branch_field_id IS DISTINCT FROM v_proj.project_name_branch;

  ---------------------------------------------------------------------------
  -- READBACK VERIFICATION — validates the rows ACTUALLY WRITTEN, not the JSON.
  -- Required-field completeness stays enforced on an update_submitted too: an
  -- employee may not strip a required field while editing a submitted expense.
  ---------------------------------------------------------------------------
  IF p_action IN ('submit','update_submitted') THEN
    PERFORM public.validate_expense_submission_invariants_v1(v_expense_id);
    -- Force the deferred constraint triggers now, so a failure rolls back
    -- inside this call rather than surfacing at COMMIT with no context.
    SET CONSTRAINTS ALL IMMEDIATE;
    -- ...then put them back. SET CONSTRAINTS applies to the whole transaction,
    -- not to this function: leaving them IMMEDIATE would make the NEXT row in a
    -- batch fire the submission guard on its INSERT, before its custom fields
    -- have been written, and fail a perfectly valid expense.
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

    -- 'expense_updated', matching the legacy in-place edit of a submitted
    -- expense (ExpenseService.updateExpense) — NOT a second submission event.
    INSERT INTO public.audit_logs (expense_id, user_id, organization_id, action, comment)
    VALUES (v_expense_id, v_uid, v_org, 'expense_updated',
            'Updated via atomic snapshot V1');
  END IF;

  ---------------------------------------------------------------------------
  -- RECEIPT — written in the same transaction as everything it describes.
  ---------------------------------------------------------------------------
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
$fn$;

COMMENT ON FUNCTION public._persist_microlink_expense_snapshot_v1(jsonb, text) IS
  'Atomic MicroLink V1 snapshot engine. Three actions: submit (draft/rejected '
  '-> submitted, resolves routing, logs expense_submitted), save_draft, and '
  'update_submitted (owner edits an ALREADY submitted expense in place -- '
  'preserves status/routing/transaction_number, logs expense_updated). '
  'Approved/paid/edited stay locked. Hotfix 2026-09-09.';

-- ----------------------------------------------------------------------------
-- 3. Public wrapper for the new action. Thin, like its siblings.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_microlink_submitted_expense_v1(p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public._persist_microlink_expense_snapshot_v1(p_snapshot, 'update_submitted');
$fn$;

COMMENT ON FUNCTION public.update_microlink_submitted_expense_v1(jsonb) IS
  'Edits an owner''s ALREADY submitted MicroLink expense in place: same '
  'expense id, organization, employee, transaction number, status, '
  'approval_tier and assigned reviewer/engineer. Updates core + custom '
  'fields atomically and logs expense_updated. Refuses any status other '
  'than submitted.';

DO $grants$
BEGIN
  REVOKE ALL ON FUNCTION public.update_microlink_submitted_expense_v1(jsonb) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.update_microlink_submitted_expense_v1(jsonb) FROM anon;
  GRANT EXECUTE ON FUNCTION public.update_microlink_submitted_expense_v1(jsonb)
    TO authenticated, service_role;
END;
$grants$;
