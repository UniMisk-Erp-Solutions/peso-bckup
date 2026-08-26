-- Rollback for 20260819171000_balance_import_reversal_archive_hardening.sql
-- Restores balance_apply_import_v1 and balance_reverse_import_v1 to their
-- exact pre-hardening bodies (as defined in
-- 20260819163000_balance_import_apply_rpc.sql).

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
  v_seen_users       uuid[] := ARRAY[]::uuid[];
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
    IF v_resolved_user_id = ANY(v_seen_users) THEN
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

    v_seen_users := array_append(v_seen_users, v_resolved_user_id);
    PERFORM 1 FROM public.profiles WHERE user_id = v_resolved_user_id FOR UPDATE;
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

CREATE OR REPLACE FUNCTION public.balance_reverse_import_v1(
  p_batch_id uuid,
  p_reason   text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_batch         public.balance_import_batches%ROWTYPE;
  v_caller_role   text;
  v_reason        text := nullif(trim(p_reason), '');
  v_ledger        record;
  v_current       numeric;
  v_new           numeric;
  v_ledger_id     uuid;
  v_reversed_count int := 0;
  v_blocked       jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reverse an import';
  END IF;

  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true;
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may reverse a balance import';
  END IF;

  IF v_batch.status <> 'applied' THEN
    RAISE EXCEPTION 'Only an applied import can be reversed (current status: %)', v_batch.status;
  END IF;

  FOR v_ledger IN
    SELECT bl.id, bl.user_id, bl.amount_delta, bl.balance_after, p.employee_id, p.name
    FROM public.balance_ledger bl
    JOIN public.profiles p ON p.user_id = bl.user_id AND p.organization_id = bl.organization_id
    WHERE bl.source_type = 'import_batch' AND bl.source_id = p_batch_id
    ORDER BY bl.created_at
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.balance_ledger later
      WHERE later.user_id = v_ledger.user_id
        AND later.organization_id = v_batch.organization_id
        AND later.created_at > (SELECT created_at FROM public.balance_ledger WHERE id = v_ledger.id)
    ) THEN
      v_blocked := v_blocked || jsonb_build_object(
        'employee_id', v_ledger.employee_id, 'employee_name', v_ledger.name,
        'reason', 'Balance changed after this import; automatic reversal requires review.'
      );
      CONTINUE;
    END IF;

    PERFORM 1 FROM public.profiles WHERE user_id = v_ledger.user_id FOR UPDATE;
    SELECT COALESCE(balance, 0) INTO v_current
    FROM public.profiles WHERE user_id = v_ledger.user_id AND organization_id = v_batch.organization_id;

    v_new := v_current - v_ledger.amount_delta;

    UPDATE public.profiles SET balance = v_new, updated_at = now()
    WHERE user_id = v_ledger.user_id AND organization_id = v_batch.organization_id;

    INSERT INTO public.balance_ledger (
      organization_id, user_id, amount_delta, balance_before, balance_after,
      entry_type, source_type, source_id, actor_user_id, note, reversal_of
    ) VALUES (
      v_batch.organization_id, v_ledger.user_id, -v_ledger.amount_delta, v_current, v_new,
      'reversal', 'reversal', p_batch_id, v_uid, v_reason, v_ledger.id
    ) RETURNING id INTO v_ledger_id;

    v_reversed_count := v_reversed_count + 1;
  END LOOP;

  IF jsonb_array_length(v_blocked) > 0 AND v_reversed_count = 0 THEN
    RAISE EXCEPTION 'Reversal blocked for all % affected employee(s): balances changed after this import. Manual review required. Details: %',
      jsonb_array_length(v_blocked), v_blocked::text;
  END IF;

  UPDATE public.balance_import_batches
  SET status = 'reversed', reversed_at = now(), reversed_by = v_uid
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id,
    'reversed_count', v_reversed_count,
    'blocked', v_blocked
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
