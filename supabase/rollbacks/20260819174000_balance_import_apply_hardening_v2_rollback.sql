-- Rollback for 20260819174000_balance_import_apply_hardening_v2.sql
-- Drops the partial unique index and restores balance_validate_import_v1 /
-- balance_apply_import_v1 to their pre-174000 bodies (164000 / 171000).

DROP INDEX IF EXISTS public.balance_import_batches_applied_org_mode_sha_unique;

CREATE OR REPLACE FUNCTION public.balance_validate_import_v1(
  p_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_batch          public.balance_import_batches%ROWTYPE;
  v_caller_role    text;
  v_row            public.balance_import_rows%ROWTYPE;
  v_resolved_id    uuid;
  v_match_count    int;
  v_name           text;
  v_current        numeric;
  v_new            numeric;
  v_status         text;
  v_code           text;
  v_message        text;
  v_seen           uuid[] := ARRAY[]::uuid[];
  v_valid_count    int := 0;
  v_invalid_count  int := 0;
  v_total_delta    numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true;
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may validate a balance import';
  END IF;

  IF v_batch.status NOT IN ('draft', 'validated') THEN
    RAISE EXCEPTION 'Cannot re-validate a batch in status %', v_batch.status;
  END IF;

  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id ORDER BY row_number
  LOOP
    v_resolved_id := NULL; v_match_count := 0; v_name := NULL;
    v_status := 'valid'; v_code := NULL; v_message := NULL;

    IF v_row.normalized_employee_id IS NOT NULL AND v_row.normalized_employee_id <> '' THEN
      SELECT count(*) INTO v_match_count
      FROM public.profiles p
      JOIN public.organization_memberships om
        ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
      WHERE p.organization_id = v_batch.organization_id AND p.employee_id = v_row.normalized_employee_id;
      IF v_match_count = 1 THEN
        SELECT p.user_id, p.name INTO v_resolved_id, v_name
        FROM public.profiles p
        JOIN public.organization_memberships om
          ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
        WHERE p.organization_id = v_batch.organization_id AND p.employee_id = v_row.normalized_employee_id;
      END IF;
    END IF;

    IF v_match_count = 0 AND v_row.normalized_email IS NOT NULL AND v_row.normalized_email <> '' THEN
      SELECT count(*) INTO v_match_count
      FROM public.profiles p
      JOIN public.organization_memberships om
        ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
      WHERE p.organization_id = v_batch.organization_id AND lower(trim(p.email)) = v_row.normalized_email;
      IF v_match_count = 1 THEN
        SELECT p.user_id, p.name INTO v_resolved_id, v_name
        FROM public.profiles p
        JOIN public.organization_memberships om
          ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
        WHERE p.organization_id = v_batch.organization_id AND lower(trim(p.email)) = v_row.normalized_email;
      END IF;
    END IF;

    IF v_match_count > 1 THEN
      v_status := 'ambiguous'; v_code := 'ambiguous_identity';
      v_message := format('%s possible matches', v_match_count);
    ELSIF v_match_count = 0 THEN
      v_status := 'unknown'; v_code := 'no_match';
      v_message := 'No employee found for the given ID/email';
    ELSIF v_resolved_id = ANY(v_seen) THEN
      v_status := 'duplicate'; v_code := 'duplicate_in_file';
      v_message := 'This employee already appears earlier in this file';
    ELSIF v_row.input_amount IS NULL OR v_row.input_amount <> v_row.input_amount
          OR v_row.input_amount = 'infinity'::numeric OR v_row.input_amount = '-infinity'::numeric THEN
      v_status := 'invalid_amount'; v_code := 'invalid_amount';
      v_message := 'Amount is missing or not a valid number';
    ELSIF v_batch.mode = 'allocation' AND v_row.input_amount < 0 THEN
      v_status := 'invalid_amount'; v_code := 'negative_allocation';
      v_message := 'Allocation amount cannot be negative';
    END IF;

    IF v_status = 'valid' THEN
      v_seen := array_append(v_seen, v_resolved_id);
      SELECT COALESCE(balance, 0) INTO v_current
      FROM public.profiles WHERE user_id = v_resolved_id AND organization_id = v_batch.organization_id;

      v_new := CASE WHEN v_batch.mode = 'historical_opening' THEN v_row.input_amount
                     ELSE v_current + v_row.input_amount END;

      IF v_new = v_current THEN
        v_status := 'no_op';
      END IF;

      v_valid_count := v_valid_count + 1;
      v_total_delta := v_total_delta + (v_new - v_current);
    ELSE
      v_invalid_count := v_invalid_count + 1;
      v_current := NULL; v_new := NULL;
    END IF;

    UPDATE public.balance_import_rows
    SET matched_user_id = v_resolved_id,
        current_balance_snapshot = v_current,
        calculated_new_balance = v_new,
        validation_status = v_status,
        validation_code = v_code,
        validation_message = v_message
    WHERE id = v_row.id;
  END LOOP;

  UPDATE public.balance_import_batches
  SET status = 'validated',
      validated_at = now(),
      row_count = v_valid_count + v_invalid_count,
      valid_row_count = v_valid_count,
      invalid_row_count = v_invalid_count,
      total_delta = v_total_delta
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id,
    'row_count', v_valid_count + v_invalid_count,
    'valid_row_count', v_valid_count,
    'invalid_row_count', v_invalid_count,
    'total_delta', v_total_delta,
    'apply_disabled', v_invalid_count > 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.balance_apply_import_v1(
  p_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_batch            public.balance_import_batches%ROWTYPE;
  v_caller_role      text;
  v_row              public.balance_import_rows%ROWTYPE;
  v_resolved_ids     uuid[] := ARRAY[]::uuid[];
  v_sorted_ids       uuid[];
  v_lock_id          uuid;
  v_resolved_user_id uuid;
  v_match_count      int;
  v_balance_before   numeric;
  v_balance_after    numeric;
  v_delta            numeric;
  v_effective        date;
  v_is_noop          boolean;
  v_ledger_id        uuid;
  v_target_name      text;
  v_target_emp_id    text;
  v_changed_count    int := 0;
  v_noop_count       int := 0;
  v_total_delta      numeric := 0;
  v_results          jsonb := '[]'::jsonb;
  v_dup_batch        record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true;

  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may apply a balance import';
  END IF;

  IF v_batch.status = 'applied' THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_applied', true, 'batch_id', p_batch_id,
      'row_count', v_batch.row_count, 'changed_count', v_batch.valid_row_count,
      'total_delta', v_batch.total_delta, 'applied_at', v_batch.applied_at
    );
  END IF;

  IF v_batch.status = 'reversed' THEN
    RAISE EXCEPTION 'This import was reversed and cannot be re-applied';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.balance_import_rows WHERE batch_id = p_batch_id) THEN
    RAISE EXCEPTION 'Import batch has no rows to apply';
  END IF;

  IF v_batch.source_storage_path IS NULL THEN
    RAISE EXCEPTION 'This import has no archived source file. Re-upload so the original can be stored before applying.';
  END IF;

  IF v_batch.source_sha256 IS NOT NULL THEN
    SELECT id, applied_at INTO v_dup_batch
    FROM public.balance_import_batches
    WHERE organization_id = v_batch.organization_id
      AND mode = v_batch.mode
      AND source_sha256 = v_batch.source_sha256
      AND status = 'applied'
      AND id <> v_batch.id
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'This exact file was already applied on % (batch %).',
        v_dup_batch.applied_at, v_dup_batch.id;
    END IF;
  END IF;

  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id ORDER BY row_number
  LOOP
    v_resolved_user_id := NULL;
    v_match_count := 0;

    IF v_row.normalized_employee_id IS NOT NULL AND v_row.normalized_employee_id <> '' THEN
      SELECT count(*) INTO v_match_count
      FROM public.profiles p
      JOIN public.organization_memberships om
        ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
      WHERE p.organization_id = v_batch.organization_id
        AND p.employee_id = v_row.normalized_employee_id;
      IF v_match_count = 1 THEN
        SELECT p.user_id INTO v_resolved_user_id
        FROM public.profiles p
        JOIN public.organization_memberships om
          ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
        WHERE p.organization_id = v_batch.organization_id
          AND p.employee_id = v_row.normalized_employee_id;
      END IF;
    END IF;

    IF v_match_count = 0 AND v_row.normalized_email IS NOT NULL AND v_row.normalized_email <> '' THEN
      SELECT count(*) INTO v_match_count
      FROM public.profiles p
      JOIN public.organization_memberships om
        ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
      WHERE p.organization_id = v_batch.organization_id
        AND lower(trim(p.email)) = v_row.normalized_email;
      IF v_match_count = 1 THEN
        SELECT p.user_id INTO v_resolved_user_id
        FROM public.profiles p
        JOIN public.organization_memberships om
          ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
        WHERE p.organization_id = v_batch.organization_id
          AND lower(trim(p.email)) = v_row.normalized_email;
      END IF;
    END IF;

    IF v_match_count > 1 THEN
      RAISE EXCEPTION 'Row %: identity is ambiguous (% possible matches). Fix the source row and re-upload.',
        v_row.row_number, v_match_count;
    END IF;
    IF v_match_count = 0 OR v_resolved_user_id IS NULL THEN
      RAISE EXCEPTION 'Row %: no matching employee found for employee_id=% email=%',
        v_row.row_number, v_row.normalized_employee_id, v_row.normalized_email;
    END IF;
    IF v_resolved_user_id = ANY(v_resolved_ids) THEN
      RAISE EXCEPTION 'Row %: this employee already appears earlier in the same import batch',
        v_row.row_number;
    END IF;
    IF v_row.input_amount IS NULL OR v_row.input_amount <> v_row.input_amount
       OR v_row.input_amount = 'infinity'::numeric OR v_row.input_amount = '-infinity'::numeric THEN
      RAISE EXCEPTION 'Row %: amount is missing or not a valid number', v_row.row_number;
    END IF;
    IF v_batch.mode = 'allocation' AND v_row.input_amount < 0 THEN
      RAISE EXCEPTION 'Row %: allocation amount cannot be negative', v_row.row_number;
    END IF;

    v_resolved_ids := array_append(v_resolved_ids, v_resolved_user_id);
  END LOOP;

  SELECT ARRAY(SELECT DISTINCT u FROM unnest(v_resolved_ids) AS u ORDER BY u) INTO v_sorted_ids;
  FOREACH v_lock_id IN ARRAY v_sorted_ids
  LOOP
    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_id FOR UPDATE;
  END LOOP;

  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id ORDER BY row_number
  LOOP
    v_resolved_user_id := NULL;
    IF v_row.normalized_employee_id IS NOT NULL AND v_row.normalized_employee_id <> '' THEN
      SELECT p.user_id, p.name, p.employee_id INTO v_resolved_user_id, v_target_name, v_target_emp_id
      FROM public.profiles p
      JOIN public.organization_memberships om
        ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
      WHERE p.organization_id = v_batch.organization_id AND p.employee_id = v_row.normalized_employee_id;
    END IF;
    IF v_resolved_user_id IS NULL AND v_row.normalized_email IS NOT NULL THEN
      SELECT p.user_id, p.name, p.employee_id INTO v_resolved_user_id, v_target_name, v_target_emp_id
      FROM public.profiles p
      JOIN public.organization_memberships om
        ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
      WHERE p.organization_id = v_batch.organization_id AND lower(trim(p.email)) = v_row.normalized_email;
    END IF;

    SELECT COALESCE(balance, 0) INTO v_balance_before
    FROM public.profiles WHERE user_id = v_resolved_user_id AND organization_id = v_batch.organization_id;

    IF v_batch.mode = 'historical_opening' THEN
      v_balance_after := v_row.input_amount;
    ELSE
      v_balance_after := v_balance_before + v_row.input_amount;
    END IF;
    v_delta := v_balance_after - v_balance_before;
    v_is_noop := (v_delta = 0);
    v_effective := COALESCE(v_row.effective_date, v_batch.default_effective_date, CURRENT_DATE);

    IF NOT v_is_noop THEN
      UPDATE public.profiles
      SET balance = v_balance_after, updated_at = now()
      WHERE user_id = v_resolved_user_id AND organization_id = v_batch.organization_id
      RETURNING balance INTO v_balance_after;

      IF v_balance_after IS NULL THEN
        RAISE EXCEPTION 'Row %: balance update affected no row; import rolled back', v_row.row_number;
      END IF;

      INSERT INTO public.balance_ledger (
        organization_id, user_id, amount_delta, balance_before, balance_after,
        entry_type, source_type, source_id, actor_user_id, effective_at, note
      ) VALUES (
        v_batch.organization_id, v_resolved_user_id, v_delta, v_balance_before, v_balance_after,
        CASE WHEN v_batch.mode = 'historical_opening' THEN 'historical_opening' ELSE 'allocation' END,
        'import_batch', p_batch_id, v_uid, v_effective, v_row.note
      ) RETURNING id INTO v_ledger_id;

      v_changed_count := v_changed_count + 1;
      v_total_delta := v_total_delta + v_delta;
    ELSE
      v_noop_count := v_noop_count + 1;
      v_ledger_id := NULL;
    END IF;

    UPDATE public.balance_import_rows
    SET matched_user_id = v_resolved_user_id,
        current_balance_snapshot = v_balance_before,
        calculated_new_balance = v_balance_after,
        validation_status = CASE WHEN v_is_noop THEN 'no_op' ELSE 'valid' END,
        ledger_entry_id = v_ledger_id
    WHERE id = v_row.id;

    v_results := v_results || jsonb_build_object(
      'row_number', v_row.row_number,
      'employee_id', v_target_emp_id,
      'employee_name', v_target_name,
      'before', v_balance_before,
      'input_amount', v_row.input_amount,
      'after', v_balance_after,
      'no_op', v_is_noop,
      'ledger_entry_id', v_ledger_id
    );
  END LOOP;

  UPDATE public.balance_import_batches
  SET status = 'applied',
      applied_at = now(),
      applied_by = v_uid,
      valid_row_count = v_changed_count + v_noop_count,
      invalid_row_count = 0,
      total_delta = v_total_delta
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', p_batch_id,
    'mode', v_batch.mode,
    'row_count', v_batch.row_count,
    'changed_count', v_changed_count,
    'no_op_count', v_noop_count,
    'total_delta', v_total_delta,
    'rows', v_results
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
