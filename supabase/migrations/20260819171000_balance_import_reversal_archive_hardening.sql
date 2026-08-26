-- DOC-099 — correctness hardening for balance_apply_import_v1 and
-- balance_reverse_import_v1, found during the pre-owner-QA review pass. New
-- additive corrective migration -- 20260819163000 stays as-applied history;
-- this CREATE OR REPLACE redefines the function bodies only.
--
-- Four fixes:
--
-- 4) Reversal was NOT all-or-nothing. The single loop both checked each
--    affected employee for later activity AND performed the reversal mutate
--    in the same pass, so some employees could be reversed while others were
--    blocked, then the batch was marked fully REVERSED regardless -- a
--    partially-reversed batch reporting itself as cleanly reversed. Fixed:
--    a PRE-FLIGHT pass now checks every affected employee for later ledger
--    activity with ZERO mutation; if any are blocked, the whole call RAISEs
--    (batch stays APPLIED, zero balance change, zero reversal ledger rows).
--    Only when every affected employee is safely reversible does a second
--    pass lock all of them (deterministic user_id order) and reverse every
--    entry in one transaction.
--
-- 5) Source archive was optional. balance_apply_import_v1 now fails closed
--    if the batch has no source_storage_path -- an import cannot be Applied
--    without its original file durably archived for audit, regardless of
--    what the UI does or doesn't enforce.
--
-- 6) source_sha256 was never checked. Before Apply, if the batch has a
--    source_sha256 recorded, this now blocks Apply when another batch in the
--    same organization + mode already reached status='applied' with the
--    identical hash -- the same file re-uploaded as a "new" batch can no
--    longer double-credit. The existing batch id + applied_at are returned
--    in the error so the UI can point the admin at it.
--
-- 7) Lock order was row-encounter order, not truly deterministic. The
--    locking pass previously issued `FOR UPDATE` inline while walking rows
--    in row_number order, so lock acquisition order depended on spreadsheet
--    row order, not user_id. Fixed: the full distinct affected user_id set
--    is resolved and validated FIRST (zero locks taken), then sorted and
--    locked in ascending user_id order -- matching the documented
--    "deterministic order" guarantee and eliminating a theoretical
--    cross-transaction deadlock class where two concurrent operations
--    touching an overlapping user set lock in different orders.

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

  -- Lock the batch row FIRST -- this is what makes a concurrent double-Apply
  -- safe: the second caller blocks here until the first transaction commits
  -- or rolls back.
  SELECT * INTO v_batch FROM public.balance_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import batch not found';
  END IF;

  SELECT om.role::text INTO v_caller_role
  FROM public.organization_memberships om
  WHERE om.user_id = v_uid AND om.organization_id = v_batch.organization_id AND om.is_active = true;

  -- V1: admin-only apply.
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins may apply a balance import';
  END IF;

  -- Idempotent short-circuit: already applied, return the existing result
  -- rather than crediting anyone again.
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

  -- (5) Fail closed if the original source file was never archived. An
  --     import cannot move money without a durable, private copy of what
  --     was uploaded -- this is enforced here regardless of what the
  --     browser does or doesn't check.
  IF v_batch.source_storage_path IS NULL THEN
    RAISE EXCEPTION 'This import has no archived source file. Re-upload so the original can be stored before applying.';
  END IF;

  -- (6) Duplicate-file protection: the same exact file, re-uploaded as a
  --     "new" batch, must never be allowed to double-credit.
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

  -- (7) Resolve + validate every row FIRST, taking ZERO locks, to build the
  --     complete distinct affected user_id set. Re-derives matched_user_id
  --     fresh from the raw identity fields -- never trusts a value staged
  --     at preview time.
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
    IF v_row.input_amount IS NULL OR v_row.input_amount <> v_row.input_amount /* NaN */
       OR v_row.input_amount = 'infinity'::numeric OR v_row.input_amount = '-infinity'::numeric THEN
      RAISE EXCEPTION 'Row %: amount is missing or not a valid number', v_row.row_number;
    END IF;
    IF v_batch.mode = 'allocation' AND v_row.input_amount < 0 THEN
      RAISE EXCEPTION 'Row %: allocation amount cannot be negative', v_row.row_number;
    END IF;

    v_resolved_ids := array_append(v_resolved_ids, v_resolved_user_id);
  END LOOP;

  -- Now that the complete distinct set is known and every row has passed
  -- validation, lock every affected profile in ascending user_id order --
  -- true deterministic order, independent of spreadsheet row order.
  SELECT ARRAY(SELECT DISTINCT u FROM unnest(v_resolved_ids) AS u ORDER BY u) INTO v_sorted_ids;
  FOREACH v_lock_id IN ARRAY v_sorted_ids
  LOOP
    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_id FOR UPDATE;
  END LOOP;

  -- Every affected row is now locked. Re-walk the rows and apply.
  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id ORDER BY row_number
  LOOP
    -- Re-resolve identically to the validation pass above (values are not
    -- carried between loops; re-derived fresh each time on purpose).
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

      -- Deliberately NO cash_transfer_history / money_assignments row for
      -- either import mode (C9/C10): those tables represent cash/bank
      -- transfers between two people, and an import is neither -- it is an
      -- administrative opening-state or allocation event. balance_ledger is
      -- its sole and sufficient record.

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

COMMENT ON FUNCTION public.balance_apply_import_v1(uuid) IS
  'DOC-099 (rev 20260819171000). Atomic, all-or-nothing bulk balance import '
  'apply. Locks the batch row first (making a concurrent double-Apply safe/'
  'idempotent), fails closed if the source file was never archived or if '
  'this exact file (by source_sha256) was already applied in this org+mode, '
  're-resolves and re-validates every staged row fresh against current '
  'profiles state with ZERO locks taken during validation, then locks every '
  'distinct affected profile row FOR UPDATE in ascending user_id order '
  '(true deterministic order, independent of spreadsheet row order) before '
  'any mutation. RAISEs before touching any balance if any row fails -- zero '
  'partial application. historical_opening SETS the balance; allocation ADDS '
  'to it. Admin-only in V1.';

-- ---------------------------------------------------------------------------
-- Reversal — all-or-nothing pre-flight, then compensating ledger entries.
-- ---------------------------------------------------------------------------
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
  v_blocked_text  text := '';
  v_affected_ids  uuid[] := ARRAY[]::uuid[];
  v_sorted_ids    uuid[];
  v_lock_id       uuid;
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

  -- (4) PRE-FLIGHT, zero mutation: check every affected employee for later
  --     ledger activity BEFORE touching anything. If ANY is blocked, the
  --     whole reversal is refused -- never a partial reversal reporting
  --     itself as fully reversed.
  FOR v_ledger IN
    SELECT bl.id, bl.user_id, bl.created_at, p.employee_id, p.name
    FROM public.balance_ledger bl
    JOIN public.profiles p ON p.user_id = bl.user_id AND p.organization_id = bl.organization_id
    WHERE bl.source_type = 'import_batch' AND bl.source_id = p_batch_id
    ORDER BY bl.created_at
  LOOP
    v_affected_ids := array_append(v_affected_ids, v_ledger.user_id);

    IF EXISTS (
      SELECT 1 FROM public.balance_ledger later
      WHERE later.user_id = v_ledger.user_id
        AND later.organization_id = v_batch.organization_id
        AND later.created_at > v_ledger.created_at
    ) THEN
      v_blocked := v_blocked || jsonb_build_object(
        'employee_id', v_ledger.employee_id, 'employee_name', v_ledger.name,
        'reason', 'Balance changed after this import; automatic reversal requires review.'
      );
      v_blocked_text := v_blocked_text
        || format(E'\n- %s (%s)', COALESCE(v_ledger.name, 'Unknown'), COALESCE(v_ledger.employee_id, v_ledger.user_id::text));
    END IF;
  END LOOP;

  IF jsonb_array_length(v_blocked) > 0 THEN
    RAISE EXCEPTION 'This import cannot be automatically reversed if any affected employee has newer balance activity. Zero changes made. Blocked (%): %',
      jsonb_array_length(v_blocked), v_blocked_text;
  END IF;

  IF array_length(v_affected_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No ledger entries found for this import batch';
  END IF;

  -- Every affected employee is safely reversible. Lock all of them in
  -- ascending user_id order before mutating any of them.
  SELECT ARRAY(SELECT DISTINCT u FROM unnest(v_affected_ids) AS u ORDER BY u) INTO v_sorted_ids;
  FOREACH v_lock_id IN ARRAY v_sorted_ids
  LOOP
    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_id FOR UPDATE;
  END LOOP;

  FOR v_ledger IN
    SELECT bl.id, bl.user_id, bl.amount_delta
    FROM public.balance_ledger bl
    WHERE bl.source_type = 'import_batch' AND bl.source_id = p_batch_id
    ORDER BY bl.created_at
  LOOP
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

  UPDATE public.balance_import_batches
  SET status = 'reversed', reversed_at = now(), reversed_by = v_uid
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id,
    'reversed_count', v_reversed_count,
    'blocked', '[]'::jsonb
  );
END;
$$;

COMMENT ON FUNCTION public.balance_reverse_import_v1(uuid, text) IS
  'DOC-099 (rev 20260819171000). Admin-only, all-or-nothing. Pre-flight '
  'checks every affected employee for later balance_ledger activity with '
  'ZERO mutation; if any employee is blocked, the whole call RAISEs (batch '
  'stays applied, zero balances changed, zero reversal rows written) rather '
  'than reversing some employees and skipping others. Only when every '
  'affected employee is safely reversible does it lock all of them '
  '(ascending user_id order) and write compensating balance_ledger reversal '
  'entries for every one of them in a single transaction -- never deletes '
  'or edits history, never blindly restores an old snapshot.';

NOTIFY pgrst, 'reload schema';
