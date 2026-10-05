-- Additive Credit Accounting V3 -- batch import path (part 2).
--
-- Mirrors the staging model already established by balance_validate_import_v2
-- / balance_apply_import_v2, but WITHOUT any target-anchor/conflict-detection
-- machinery -- an additive credit cannot "conflict" with anything, since it
-- never claims to set a balance, only to change it by a fixed amount.
--
-- balance_import_rows.input_amount is reused as-is (already the exact
-- Tally/admin-entered amount, per src/lib/tallyBalanceImport.ts's
-- signedClosingBalance -- unchanged by this migration). What changes is
-- ONLY how that number is interpreted at apply time: as a delta, never a
-- target.

BEGIN;

CREATE OR REPLACE FUNCTION public.balance_validate_import_v3(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_role   text;
  v_batch  record;
  v_valid  integer := 0;
  v_invalid integer := 0;
  v_total_delta numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;
  IF v_batch.mode NOT IN ('opening_credit', 'balance_credit') THEN
    RAISE EXCEPTION 'balance_validate_import_v3 only validates opening_credit/balance_credit batches';
  END IF;

  SELECT om.role::text INTO v_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true
  LIMIT 1;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only an organization admin may validate an import batch';
  END IF;
  IF v_batch.status NOT IN ('draft', 'validated') THEN
    RAISE EXCEPTION 'Batch is not in a validatable state (status: %)', v_batch.status;
  END IF;

  -- Resolve identity: Employee ID is always authoritative, never fuzzy-matched.
  UPDATE public.balance_import_rows r
  SET matched_user_id = p.user_id,
      current_balance_snapshot = COALESCE(p.balance, 0)
  FROM public.profiles p
  WHERE r.batch_id = p_batch_id
    AND p.organization_id = v_batch.organization_id
    AND p.is_active = true
    AND r.normalized_employee_id IS NOT NULL
    AND p.employee_id = r.normalized_employee_id;

  UPDATE public.balance_import_rows r
  SET calculated_new_balance = r.current_balance_snapshot + r.input_amount
  WHERE r.batch_id = p_batch_id AND r.matched_user_id IS NOT NULL AND r.input_amount IS NOT NULL;

  UPDATE public.balance_import_rows r
  SET validation_status = 'unknown', validation_code = 'unknown_employee',
      validation_message = 'Employee ID ' || COALESCE(r.raw_employee_id, '') || ' was not found in PesoWise and will be skipped.'
  WHERE r.batch_id = p_batch_id AND r.matched_user_id IS NULL AND r.normalized_employee_id IS NOT NULL;

  UPDATE public.balance_import_rows r
  SET validation_status = 'unknown', validation_code = 'unidentified',
      validation_message = 'This row could not be matched to an employee and will be skipped.'
  WHERE r.batch_id = p_batch_id AND r.normalized_employee_id IS NULL;

  UPDATE public.balance_import_rows r
  SET validation_status = 'invalid_amount', validation_code = 'invalid_amount',
      validation_message = 'Amount is missing or zero.'
  WHERE r.batch_id = p_batch_id AND r.matched_user_id IS NOT NULL
    AND (r.input_amount IS NULL OR r.input_amount = 0);

  UPDATE public.balance_import_rows r
  SET validation_status = 'invalid_date', validation_code = 'invalid_date',
      validation_message = 'Effective date is missing.'
  WHERE r.batch_id = p_batch_id AND r.matched_user_id IS NOT NULL
    AND r.input_amount IS NOT NULL AND r.input_amount <> 0
    AND r.effective_date IS NULL;

  UPDATE public.balance_import_rows r
  SET validation_status = 'valid', validation_code = NULL, validation_message = NULL
  WHERE r.batch_id = p_batch_id AND r.matched_user_id IS NOT NULL
    AND r.input_amount IS NOT NULL AND r.input_amount <> 0
    AND r.effective_date IS NOT NULL;

  SELECT count(*) FILTER (WHERE validation_status = 'valid'),
         count(*) FILTER (WHERE validation_status <> 'valid'),
         COALESCE(sum(input_amount) FILTER (WHERE validation_status = 'valid'), 0)
  INTO v_valid, v_invalid, v_total_delta
  FROM public.balance_import_rows WHERE batch_id = p_batch_id;

  UPDATE public.balance_import_batches
  SET status = 'validated', validated_at = now(),
      valid_row_count = v_valid, invalid_row_count = v_invalid, total_delta = v_total_delta
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id, 'row_count', v_valid + v_invalid,
    'valid_row_count', v_valid, 'invalid_row_count', v_invalid, 'total_delta', v_total_delta
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_validate_import_v3(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_validate_import_v3(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_validate_import_v3(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.balance_apply_import_v3(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_role   text;
  v_batch  record;
  v_row    record;
  v_applied integer := 0;
  v_result jsonb;
  v_rows   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;
  IF v_batch.mode NOT IN ('opening_credit', 'balance_credit') THEN
    RAISE EXCEPTION 'balance_apply_import_v3 only applies opening_credit/balance_credit batches';
  END IF;

  SELECT om.role::text INTO v_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true
  LIMIT 1;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only an organization admin may apply an import batch';
  END IF;

  -- Idempotent at the batch level: already-applied batches just report the
  -- existing outcome rather than re-crediting every row a second time.
  IF v_batch.status = 'applied' THEN
    RETURN jsonb_build_object('ok', true, 'already_applied', true, 'batch_id', p_batch_id);
  END IF;
  IF v_batch.status <> 'validated' THEN
    RAISE EXCEPTION 'Batch must be validated before it can be applied (status: %)', v_batch.status;
  END IF;

  UPDATE public.balance_import_batches SET status = 'applying' WHERE id = p_batch_id;

  FOR v_row IN
    SELECT * FROM public.balance_import_rows
    WHERE batch_id = p_batch_id AND validation_status = 'valid' AND ledger_entry_id IS NULL
    ORDER BY row_number
  LOOP
    v_result := public._balance_apply_credit_core_v3(
      v_batch.organization_id, v_row.matched_user_id, v_row.input_amount,
      v_batch.mode, v_row.effective_date, 'import_batch_v3', p_batch_id, v_uid,
      v_batch.note, NULL
    );

    UPDATE public.balance_import_rows
    SET ledger_entry_id = (v_result->>'ledger_entry_id')::uuid,
        calculated_new_balance = (v_result->>'balance_after')::numeric
    WHERE id = v_row.id;

    v_applied := v_applied + 1;
    v_rows := v_rows || jsonb_build_object(
      'row_number', v_row.row_number, 'user_id', v_row.matched_user_id,
      'amount', v_row.input_amount, 'balance_after', (v_result->>'balance_after')::numeric
    );
  END LOOP;

  UPDATE public.balance_import_batches
  SET status = 'applied', applied_at = now(), applied_by = v_uid
  WHERE id = p_batch_id;

  RETURN jsonb_build_object('ok', true, 'already_applied', false, 'batch_id', p_batch_id, 'applied_count', v_applied, 'rows', v_rows);
EXCEPTION WHEN OTHERS THEN
  UPDATE public.balance_import_batches SET status = 'failed' WHERE id = p_batch_id AND status = 'applying';
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.balance_apply_import_v3(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_apply_import_v3(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_apply_import_v3(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.balance_reverse_import_v3(p_batch_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_role   text;
  v_batch  record;
  v_row    record;
  v_count  integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse an import batch';
  END IF;

  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;
  IF v_batch.mode NOT IN ('opening_credit', 'balance_credit') THEN
    RAISE EXCEPTION 'balance_reverse_import_v3 only reverses opening_credit/balance_credit batches';
  END IF;

  SELECT om.role::text INTO v_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true
  LIMIT 1;
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'Only an organization admin may reverse an import batch';
  END IF;
  IF v_batch.status <> 'applied' THEN
    RAISE EXCEPTION 'Only an applied batch can be reversed (status: %)', v_batch.status;
  END IF;

  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id AND ledger_entry_id IS NOT NULL
  LOOP
    PERFORM public.balance_reverse_credit_v3(v_row.ledger_entry_id, p_reason);
    v_count := v_count + 1;
  END LOOP;

  UPDATE public.balance_import_batches
  SET status = 'reversed', reversed_at = now(), reversed_by = v_uid
  WHERE id = p_batch_id;

  RETURN jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'reversed_count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.balance_reverse_import_v3(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_reverse_import_v3(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_reverse_import_v3(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- Capability probe for the NEW additive engine. The OLD probe
-- (balance_historical_v2_capabilities_v1) is untouched -- it still checks
-- the nine old anchor-engine functions, which still exist and still work
-- for anyone routing through the old (now UI-disconnected) path.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.balance_additive_v3_capabilities_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_names text[] := ARRAY[
    'balance_apply_credit_v3', 'balance_reverse_credit_v3',
    'balance_validate_import_v3', 'balance_apply_import_v3', 'balance_reverse_import_v3',
    'get_my_unified_balance_timeline_v3', 'get_org_balance_timeline_v3'
  ];
  v_functions jsonb := '{}'::jsonb;
  v_name text;
  v_ready boolean := true;
  v_exists boolean;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = v_name AND n.nspname = 'public'
    ) INTO v_exists;
    v_functions := v_functions || jsonb_build_object(v_name, v_exists);
    v_ready := v_ready AND v_exists;
  END LOOP;

  RETURN jsonb_build_object('contract', 'balance-additive-v3', 'version', 1, 'ready', v_ready, 'functions', v_functions);
END;
$$;

REVOKE ALL ON FUNCTION public.balance_additive_v3_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_additive_v3_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_additive_v3_capabilities_v1() TO authenticated;

COMMIT;
