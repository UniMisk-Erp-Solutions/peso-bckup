-- Additive Credit V3 -- zero-amount no-op fix (part 4).
--
-- Real bug found from the owner's full 61-row Tally validation table:
-- balance_validate_import_v3 classified `input_amount = 0` as
-- 'invalid_amount' ("Amount is missing or zero."). Zero is not an error --
-- it means the employee's balance does not change. The 61-row file proves
-- signed additive arithmetic (positive AND negative deltas) was already
-- correct; only the zero classification was wrong.
--
-- New, deterministic, mutually-exclusive classification (single CASE-based
-- UPDATE, first-match-wins, replacing 5 sequential UPDATEs that could
-- otherwise overwrite each other in the wrong order):
--   normalized_employee_id IS NULL              -> 'unknown' / unidentified
--   matched_user_id IS NULL (id parsed but no match) -> 'unknown' / unknown_employee
--   input_amount IS NULL                        -> 'invalid_amount' (genuine read failure)
--   effective_date IS NULL                      -> 'invalid_date'
--   input_amount = 0                            -> 'no_op' (NEW: not an error)
--   otherwise (input_amount <> 0, any sign)      -> 'valid'
--
-- balance_apply_import_v3 already filters `WHERE validation_status = 'valid'`
-- (see 20260901121500_additive_credit_v3_import.sql) -- it therefore already
-- correctly excludes 'no_op' rows without any change: a no-op row creates NO
-- balance_ledger entry and NO profiles.balance mutation, simply by never
-- being selected into the apply loop. Only the validator needed fixing.

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
  v_no_op  integer := 0;
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

  -- Single deterministic pass: first matching WHEN wins, so no later UPDATE
  -- can silently overwrite an earlier, correct classification.
  UPDATE public.balance_import_rows r
  SET
    validation_status = CASE
      WHEN r.matched_user_id IS NULL AND r.normalized_employee_id IS NOT NULL THEN 'unknown'
      WHEN r.normalized_employee_id IS NULL THEN 'unknown'
      WHEN r.input_amount IS NULL THEN 'invalid_amount'
      WHEN r.effective_date IS NULL THEN 'invalid_date'
      WHEN r.input_amount = 0 THEN 'no_op'
      ELSE 'valid'
    END,
    validation_code = CASE
      WHEN r.matched_user_id IS NULL AND r.normalized_employee_id IS NOT NULL THEN 'unknown_employee'
      WHEN r.normalized_employee_id IS NULL THEN 'unidentified'
      WHEN r.input_amount IS NULL THEN 'invalid_amount'
      WHEN r.effective_date IS NULL THEN 'invalid_date'
      WHEN r.input_amount = 0 THEN 'no_op'
      ELSE NULL
    END,
    validation_message = CASE
      WHEN r.matched_user_id IS NULL AND r.normalized_employee_id IS NOT NULL THEN
        'Employee ID ' || COALESCE(r.raw_employee_id, '') || ' was not found in PesoWise and will be skipped.'
      WHEN r.normalized_employee_id IS NULL THEN
        'This row could not be matched to an employee and will be skipped.'
      WHEN r.input_amount IS NULL THEN 'Amount could not be read.'
      WHEN r.effective_date IS NULL THEN 'Effective date is missing.'
      WHEN r.input_amount = 0 THEN 'No balance change.'
      ELSE NULL
    END
  WHERE r.batch_id = p_batch_id;

  SELECT
    count(*) FILTER (WHERE validation_status = 'valid'),
    count(*) FILTER (WHERE validation_status = 'no_op'),
    count(*) FILTER (WHERE validation_status NOT IN ('valid', 'no_op')),
    COALESCE(sum(input_amount) FILTER (WHERE validation_status = 'valid'), 0)
  INTO v_valid, v_no_op, v_invalid, v_total_delta
  FROM public.balance_import_rows WHERE batch_id = p_batch_id;

  UPDATE public.balance_import_batches
  SET status = 'validated', validated_at = now(),
      valid_row_count = v_valid, invalid_row_count = v_invalid, total_delta = v_total_delta
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id, 'row_count', v_valid + v_no_op + v_invalid,
    'valid_row_count', v_valid, 'no_op_row_count', v_no_op, 'invalid_row_count', v_invalid,
    'total_delta', v_total_delta
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_validate_import_v3(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_validate_import_v3(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_validate_import_v3(uuid) TO authenticated;

COMMIT;
