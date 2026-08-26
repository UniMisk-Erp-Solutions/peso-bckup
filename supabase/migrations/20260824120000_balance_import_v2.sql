-- Historical Balance Anchors V2 -- bulk import validate/apply.
--
-- balance_validate_import_v1 / balance_apply_import_v1 (20260819163000,
-- 20260819174000) are left completely unedited and stay live for backward
-- compatibility (Section 17) -- their historical_opening semantics are now
-- known-wrong for that use case (they SET the balance instead of anchoring
-- it), so the frontend on this branch stops calling them for
-- historical_opening/balance_update. They still work unchanged for anyone
-- who has not moved to v2, and allocation-mode behavior is byte-identical
-- between v1 and v2.
--
-- v2 adds:
--   * balance_update as a first-class import mode (mirrors
--     historical_opening's row shape, different balance_ledger entry_type)
--   * conflict detection during validate for both historical modes
--     (existing active Opening Balance, or an existing same-day anchor)
--   * per-row resolution actions at apply time: create / replace / edit /
--     skip -- read from balance_import_rows' new resolution_* columns
--   * delegates every historical_opening/balance_update row to the single-
--     anchor engine (_balance_apply_historical_anchor_core_v1, companion
--     migration) instead of re-implementing the arithmetic here
--   * allocation mode is untouched arithmetic, ported verbatim from v1

BEGIN;

CREATE OR REPLACE FUNCTION public.balance_validate_import_v2(
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
  v_row_count      int;
  v_anchor_kind    text;
  v_day_position   smallint;
  v_conflict_status text;
  v_conflict_type   text;
  v_existing_opening record;
  v_existing_same_day_count int;
  v_position_before numeric;
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

  SELECT count(*) INTO v_row_count FROM public.balance_import_rows WHERE batch_id = p_batch_id;
  IF v_row_count > 5000 THEN
    RAISE EXCEPTION 'This import contains % rows. The maximum allowed per import is 5,000.', v_row_count;
  END IF;

  v_anchor_kind := CASE v_batch.mode WHEN 'historical_opening' THEN 'opening_balance'
                                      WHEN 'balance_update' THEN 'balance_update'
                                      ELSE NULL END;
  v_day_position := CASE v_anchor_kind WHEN 'opening_balance' THEN 0 WHEN 'balance_update' THEN 2 ELSE NULL END;

  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id ORDER BY row_number
  LOOP
    v_resolved_id := NULL; v_match_count := 0; v_name := NULL;
    v_status := 'valid'; v_code := NULL; v_message := NULL;
    v_conflict_status := 'none'; v_conflict_type := NULL; v_position_before := NULL;

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
      v_message := CASE WHEN v_anchor_kind IS NOT NULL THEN 'Target balance is missing or not a valid number'
                        ELSE 'Amount is missing or not a valid number' END;
    ELSIF v_batch.mode = 'allocation' AND v_row.input_amount < 0 THEN
      v_status := 'invalid_amount'; v_code := 'negative_allocation';
      v_message := 'Allocation amount cannot be negative';
    ELSIF v_anchor_kind IS NOT NULL AND v_row.effective_date IS NULL THEN
      v_status := 'invalid_date'; v_code := 'missing_effective_date';
      v_message := 'Effective Date is required for Opening Balance / Balance Update rows';
    END IF;

    IF v_status = 'valid' THEN
      v_seen := array_append(v_seen, v_resolved_id);

      IF v_anchor_kind IS NOT NULL THEN
        -- Conflict detection (does not block validation_status -- apply
        -- enforces that an unresolved conflict blocks Apply).
        IF v_anchor_kind = 'opening_balance' THEN
          SELECT id, effective_date, stated_balance, note, created_by, created_at
            INTO v_existing_opening
          FROM public.balance_historical_anchors
          WHERE organization_id = v_batch.organization_id AND user_id = v_resolved_id
            AND anchor_kind = 'opening_balance' AND status = 'active';
          IF FOUND THEN
            v_conflict_status := 'conflict';
            v_conflict_type := 'opening_balance_exists';
          END IF;
        END IF;

        IF v_conflict_status = 'none' THEN
          SELECT count(*) INTO v_existing_same_day_count
          FROM public.balance_historical_anchors a
          WHERE a.organization_id = v_batch.organization_id AND a.user_id = v_resolved_id
            AND a.anchor_kind = v_anchor_kind AND a.effective_date = v_row.effective_date AND a.status = 'active';
          IF v_existing_same_day_count > 0 THEN
            v_conflict_status := 'conflict';
            v_conflict_type := 'same_day_anchor_exists';
          END IF;
        END IF;

        -- Lightweight preview numbers (no downstream-cascade simulation --
        -- that is reserved for the single-anchor preview RPC, which the UI
        -- calls when the admin drills into an individual conflict).
        v_position_before := public._balance_historical_position_before_v1(
          v_batch.organization_id, v_resolved_id, v_row.effective_date, v_day_position,
          public._balance_next_anchor_sequence_v1(v_batch.organization_id, v_resolved_id, v_row.effective_date, v_anchor_kind),
          NULL
        );
        v_current := (SELECT COALESCE(balance, 0) FROM public.profiles WHERE user_id = v_resolved_id AND organization_id = v_batch.organization_id);
        v_new := v_current + (v_row.input_amount - v_position_before);
        IF v_conflict_status = 'none' AND v_row.input_amount = v_position_before THEN
          v_status := 'no_op';
        END IF;
      ELSE
        SELECT COALESCE(balance, 0) INTO v_current
        FROM public.profiles WHERE user_id = v_resolved_id AND organization_id = v_batch.organization_id;
        v_new := v_current + v_row.input_amount;
        IF v_new = v_current THEN
          v_status := 'no_op';
        END IF;
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
        historical_position_before = v_position_before,
        validation_status = v_status,
        validation_code = v_code,
        validation_message = v_message,
        conflict_status = v_conflict_status,
        conflict_type = v_conflict_type
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
    'conflict_count', (SELECT count(*) FROM public.balance_import_rows WHERE batch_id = p_batch_id AND conflict_status = 'conflict'),
    'apply_disabled', v_invalid_count > 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_validate_import_v2(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_validate_import_v2(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_validate_import_v2(uuid) TO authenticated;

COMMENT ON FUNCTION public.balance_validate_import_v2(uuid) IS
  'Historical Balance Anchors V2 preview/dry-run. Extends v1''s identity/'
  'amount validation with: balance_update as a mode, invalid_date for a '
  'missing Effective Date on either historical mode, and conflict detection '
  '(existing active Opening Balance, or an existing same-day anchor) '
  'surfaced via conflict_status/conflict_type per row. Never mutates '
  'profiles.balance or balance_historical_anchors. Allocation-mode rows are '
  'processed identically to v1.';

-- ---------------------------------------------------------------------------
-- Apply. p_row_resolutions is a JSONB object keyed by row_number (as text),
-- e.g. {"3": {"action":"replace","target_anchor_id":"...","reason":"..."},
-- "7": {"action":"skip"}}. A row with conflict_status='conflict' and no
-- entry here (and no resolution_action already recorded on the row itself
-- from a prior partial resolution pass) blocks the WHOLE apply -- no
-- partial financial import, matching v1's all-or-nothing philosophy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.balance_apply_import_v2(
  p_batch_id         uuid,
  p_row_resolutions  jsonb DEFAULT '{}'::jsonb
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
  v_row_count        int;
  v_dup_batch        record;
  v_anchor_kind      text;
  v_resolution       jsonb;
  v_action           text;
  v_target_anchor_id uuid;
  v_reason           text;
  v_override_balance numeric;
  v_override_date    date;
  v_override_note    text;
  v_core_result      jsonb;
  v_target_name      text;
  v_target_emp_id    text;
  v_balance_before   numeric;
  v_balance_after    numeric;
  v_delta            numeric;
  v_effective        date;
  v_is_noop          boolean;
  v_ledger_id        uuid;
  v_changed_count    int := 0;
  v_noop_count       int := 0;
  v_skipped_count    int := 0;
  v_total_delta      numeric := 0;
  v_results          jsonb := '[]'::jsonb;
  v_unresolved       int;
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

  SELECT count(*) INTO v_row_count FROM public.balance_import_rows WHERE batch_id = p_batch_id;
  IF v_row_count > 5000 THEN
    RAISE EXCEPTION 'This import contains % rows. The maximum allowed per import is 5,000.', v_row_count;
  END IF;

  IF v_batch.source_storage_path IS NULL THEN
    RAISE EXCEPTION 'This import has no archived source file. Re-upload so the original can be stored before applying.';
  END IF;
  IF (storage.foldername(v_batch.source_storage_path))[1] IS DISTINCT FROM v_batch.organization_id::text
     OR (storage.foldername(v_batch.source_storage_path))[2] IS DISTINCT FROM v_batch.id::text THEN
    RAISE EXCEPTION 'The archived source file path does not match this import batch.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects so
    WHERE so.bucket_id = 'balance-import-archive' AND so.name = v_batch.source_storage_path
  ) THEN
    RAISE EXCEPTION 'The archived source file could not be found in private storage. Re-upload before applying.';
  END IF;
  IF v_batch.source_sha256 IS NULL OR trim(v_batch.source_sha256) = '' THEN
    RAISE EXCEPTION 'This import is missing its source-file fingerprint. Re-upload the source file before applying.';
  END IF;

  SELECT id, applied_at INTO v_dup_batch
  FROM public.balance_import_batches
  WHERE organization_id = v_batch.organization_id AND mode = v_batch.mode
    AND source_sha256 = v_batch.source_sha256 AND status = 'applied' AND id <> v_batch.id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'This exact file was already applied on % (batch %).', v_dup_batch.applied_at, v_dup_batch.id;
  END IF;

  v_anchor_kind := CASE v_batch.mode WHEN 'historical_opening' THEN 'opening_balance'
                                      WHEN 'balance_update' THEN 'balance_update'
                                      ELSE NULL END;

  -- Whole-batch atomicity gate: every conflicted row must have an explicit
  -- resolution (either already recorded on the row from a prior save, or
  -- supplied fresh in p_row_resolutions) before ANY row in this batch is
  -- allowed to move money.
  SELECT count(*) INTO v_unresolved
  FROM public.balance_import_rows r
  WHERE r.batch_id = p_batch_id
    AND r.conflict_status = 'conflict'
    AND r.resolution_action IS NULL
    AND NOT (p_row_resolutions ? r.row_number::text);
  IF v_unresolved > 0 THEN
    RAISE EXCEPTION '% row(s) have an unresolved conflict. Resolve or skip every conflict before applying.', v_unresolved;
  END IF;

  -- Resolve + validate every row FIRST (zero locks), building the distinct
  -- affected user_id set -- deterministic ascending-user_id locking, same
  -- pattern as v1.
  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id ORDER BY row_number
  LOOP
    v_resolution := COALESCE(p_row_resolutions -> v_row.row_number::text, '{}'::jsonb);
    v_action := COALESCE(v_resolution ->> 'action', v_row.resolution_action);
    IF v_row.conflict_status = 'conflict' AND v_action = 'skip' THEN
      CONTINUE; -- skipped rows never touch identity resolution or locking
    END IF;

    v_resolved_user_id := NULL;
    v_match_count := 0;

    IF v_row.normalized_employee_id IS NOT NULL AND v_row.normalized_employee_id <> '' THEN
      SELECT count(*) INTO v_match_count
      FROM public.profiles p
      JOIN public.organization_memberships om
        ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
      WHERE p.organization_id = v_batch.organization_id AND p.employee_id = v_row.normalized_employee_id;
      IF v_match_count = 1 THEN
        SELECT p.user_id INTO v_resolved_user_id
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
        SELECT p.user_id INTO v_resolved_user_id
        FROM public.profiles p
        JOIN public.organization_memberships om
          ON om.user_id = p.user_id AND om.organization_id = p.organization_id AND om.is_active = true
        WHERE p.organization_id = v_batch.organization_id AND lower(trim(p.email)) = v_row.normalized_email;
      END IF;
    END IF;

    IF v_match_count > 1 THEN
      RAISE EXCEPTION 'Row %: identity is ambiguous (% possible matches). Fix the source row and re-upload.', v_row.row_number, v_match_count;
    END IF;
    IF v_match_count = 0 OR v_resolved_user_id IS NULL THEN
      RAISE EXCEPTION 'Row %: no matching employee found for employee_id=% email=%', v_row.row_number, v_row.normalized_employee_id, v_row.normalized_email;
    END IF;
    IF v_resolved_user_id = ANY(v_resolved_ids) THEN
      RAISE EXCEPTION 'Row %: this employee already appears earlier in the same import batch', v_row.row_number;
    END IF;
    IF v_row.input_amount IS NULL OR v_row.input_amount <> v_row.input_amount
       OR v_row.input_amount = 'infinity'::numeric OR v_row.input_amount = '-infinity'::numeric THEN
      RAISE EXCEPTION 'Row %: amount is missing or not a valid number', v_row.row_number;
    END IF;
    IF v_batch.mode = 'allocation' AND v_row.input_amount < 0 THEN
      RAISE EXCEPTION 'Row %: allocation amount cannot be negative', v_row.row_number;
    END IF;
    IF v_anchor_kind IS NOT NULL AND v_row.effective_date IS NULL AND v_resolution ->> 'override_effective_date' IS NULL THEN
      RAISE EXCEPTION 'Row %: Effective Date is required', v_row.row_number;
    END IF;

    v_resolved_ids := array_append(v_resolved_ids, v_resolved_user_id);
  END LOOP;

  SELECT ARRAY(SELECT DISTINCT u FROM unnest(v_resolved_ids) AS u ORDER BY u) INTO v_sorted_ids;
  FOREACH v_lock_id IN ARRAY v_sorted_ids
  LOOP
    PERFORM 1 FROM public.profiles WHERE user_id = v_lock_id FOR UPDATE;
  END LOOP;

  -- Every affected row is now locked. Re-walk and apply.
  FOR v_row IN
    SELECT * FROM public.balance_import_rows WHERE batch_id = p_batch_id ORDER BY row_number
  LOOP
    v_resolution := COALESCE(p_row_resolutions -> v_row.row_number::text, '{}'::jsonb);
    v_action := COALESCE(v_resolution ->> 'action', v_row.resolution_action);

    IF v_row.conflict_status = 'conflict' AND v_action = 'skip' THEN
      UPDATE public.balance_import_rows
      SET resolution_action = 'skip', conflict_status = 'skipped', validation_status = 'no_op',
          validation_message = 'Skipped by admin decision'
      WHERE id = v_row.id;
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;
    END IF;

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

    IF v_anchor_kind IS NOT NULL THEN
      v_target_anchor_id := COALESCE((v_resolution ->> 'target_anchor_id')::uuid, v_row.resolution_target_anchor_id);
      v_reason := COALESCE(v_resolution ->> 'reason', v_row.resolution_reason);
      v_override_balance := COALESCE((v_resolution ->> 'override_balance')::numeric, v_row.resolution_override_balance, v_row.input_amount);
      v_override_date := COALESCE((v_resolution ->> 'override_effective_date')::date, v_row.resolution_override_effective_date, v_row.effective_date);
      v_override_note := COALESCE(v_resolution ->> 'override_note', v_row.resolution_override_note, v_row.note);

      -- 'create' (no conflict, or admin explicitly chose to add alongside
      -- an existing same-day anchor) and 'replace'/'edit' (supersede an
      -- existing anchor -- edit differs only in that the admin may have
      -- overridden the staged values first) both map onto the two-action
      -- core engine.
      IF v_action IN ('replace', 'edit') THEN
        IF v_target_anchor_id IS NULL THEN
          RAISE EXCEPTION 'Row %: % requires an existing anchor to replace', v_row.row_number, v_action;
        END IF;
        IF v_reason IS NULL OR trim(v_reason) = '' THEN
          RAISE EXCEPTION 'Row %: a reason is required to %', v_row.row_number, v_action;
        END IF;
        v_core_result := public._balance_apply_historical_anchor_core_v1(
          v_batch.organization_id, v_resolved_user_id, v_anchor_kind, v_override_date, v_override_balance,
          'supersede', v_override_note, v_target_anchor_id, v_reason, p_batch_id, v_row.id, v_uid
        );
      ELSE
        v_core_result := public._balance_apply_historical_anchor_core_v1(
          v_batch.organization_id, v_resolved_user_id, v_anchor_kind, v_override_date, v_override_balance,
          'create', v_override_note, NULL, NULL, p_batch_id, v_row.id, v_uid
        );
      END IF;

      v_balance_before := (v_core_result ->> 'current_balance_before')::numeric;
      v_balance_after := (v_core_result ->> 'current_balance_after')::numeric;
      v_delta := (v_core_result ->> 'materialized_delta')::numeric;
      v_is_noop := (v_delta = 0);

      UPDATE public.balance_import_rows
      SET matched_user_id = v_resolved_user_id,
          current_balance_snapshot = v_balance_before,
          calculated_new_balance = v_balance_after,
          validation_status = CASE WHEN v_is_noop THEN 'no_op' ELSE 'valid' END,
          conflict_status = 'resolved',
          resolution_action = COALESCE(v_action, 'create'),
          resolution_target_anchor_id = v_target_anchor_id,
          resolution_reason = v_reason,
          resulting_anchor_id = (v_core_result ->> 'anchor_id')::uuid
      WHERE id = v_row.id;

      IF NOT v_is_noop THEN
        v_changed_count := v_changed_count + 1;
        v_total_delta := v_total_delta + v_delta;
      ELSE
        v_noop_count := v_noop_count + 1;
      END IF;

      v_results := v_results || jsonb_build_object(
        'row_number', v_row.row_number, 'employee_id', v_target_emp_id, 'employee_name', v_target_name,
        'before', v_balance_before, 'input_amount', v_row.input_amount, 'after', v_balance_after,
        'no_op', v_is_noop, 'anchor_id', v_core_result ->> 'anchor_id',
        'downstream_anchors_recalculated', v_core_result -> 'downstream_anchors_recalculated'
      );
    ELSE
      -- allocation mode: byte-identical arithmetic to v1.
      SELECT COALESCE(balance, 0) INTO v_balance_before
      FROM public.profiles WHERE user_id = v_resolved_user_id AND organization_id = v_batch.organization_id;
      v_balance_after := v_balance_before + v_row.input_amount;
      v_delta := v_balance_after - v_balance_before;
      v_is_noop := (v_delta = 0);
      v_effective := COALESCE(v_row.effective_date, v_batch.default_effective_date, CURRENT_DATE);

      IF NOT v_is_noop THEN
        UPDATE public.profiles SET balance = v_balance_after, updated_at = now()
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
          'allocation', 'import_batch', p_batch_id, v_uid, v_effective, v_row.note
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
        'row_number', v_row.row_number, 'employee_id', v_target_emp_id, 'employee_name', v_target_name,
        'before', v_balance_before, 'input_amount', v_row.input_amount, 'after', v_balance_after,
        'no_op', v_is_noop, 'ledger_entry_id', v_ledger_id
      );
    END IF;
  END LOOP;

  BEGIN
    UPDATE public.balance_import_batches
    SET status = 'applied', applied_at = now(), applied_by = v_uid,
        valid_row_count = v_changed_count + v_noop_count, invalid_row_count = 0, total_delta = v_total_delta
    WHERE id = p_batch_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This exact file was already applied by a concurrent request. Zero changes made.';
  END;

  RETURN jsonb_build_object(
    'ok', true, 'batch_id', p_batch_id, 'mode', v_batch.mode,
    'row_count', v_batch.row_count, 'changed_count', v_changed_count,
    'no_op_count', v_noop_count, 'skipped_count', v_skipped_count,
    'total_delta', v_total_delta, 'rows', v_results
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_apply_import_v2(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_apply_import_v2(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_apply_import_v2(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.balance_apply_import_v2(uuid, jsonb) IS
  'Historical Balance Anchors V2 atomic apply. Every historical_opening/'
  'balance_update row is delegated to _balance_apply_historical_anchor_core_v1 '
  '(one call per row, same engine as the single-anchor RPC) rather than '
  're-implementing the anchor arithmetic here. Allocation-mode rows use the '
  'same direct current+amount arithmetic as v1, unchanged. Whole-batch '
  'atomic: any row with an unresolved conflict (no resolution_action, '
  'neither pre-recorded nor supplied in p_row_resolutions) blocks the '
  'entire apply. All-or-nothing per the same deterministic ascending-'
  'user_id locking as v1.';

COMMIT;

NOTIFY pgrst, 'reload schema';
