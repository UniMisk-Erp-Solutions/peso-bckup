-- DOC-099 — bulk balance import: dry-run validation RPC + private source
-- archive storage bucket.
--
-- balance_validate_import_v1 is the "Preview" step (D1: upload must NOT
-- mutate immediately). It resolves identity and computes the would-be
-- before/after for every staged row, entirely read-only against profiles --
-- no balance, no ledger, no legacy table is ever touched here. Apply
-- (20260819163000) re-runs the identical resolution fresh anyway and never
-- trusts what this step staged, per the explicit "browser does not send
-- matched_user_id as unquestioned authority" requirement -- this function
-- exists purely so the UI can render an accurate Preview table without one
-- network round trip per spreadsheet row.

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

REVOKE ALL ON FUNCTION public.balance_validate_import_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_validate_import_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_validate_import_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.balance_validate_import_v1(uuid) IS
  'DOC-099. Read-only Preview/dry-run for a staged import batch: resolves '
  'employee identity and computes the would-be before/after balance for '
  'every row, writing only to balance_import_rows staging columns. NEVER '
  'touches profiles.balance or balance_ledger. Apply re-validates everything '
  'fresh regardless -- this exists only so the UI can render an accurate '
  'Preview table in one round trip.';

-- ---------------------------------------------------------------------------
-- Private source-file archive (FUTURE_PLANS.md #17). Never public.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'balance-import-archive',
  'balance-import-archive',
  false,
  10485760, -- 10MB
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Path convention: {organization_id}/{batch_id}/{original_filename}
DROP POLICY IF EXISTS "Admins upload own org import archive" ON storage.objects;
CREATE POLICY "Admins upload own org import archive"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'balance-import-archive'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id::text = (storage.foldername(name))[1]
        AND om.role = 'admin' AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins read own org import archive" ON storage.objects;
CREATE POLICY "Admins read own org import archive"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'balance-import-archive'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id::text = (storage.foldername(name))[1]
        AND om.role = 'admin' AND om.is_active = true
    )
  );

-- No UPDATE/DELETE policy: an archived import source file is permanent for
-- the life of the batch, matching FUTURE_PLANS.md's "immutable/private
-- storage" requirement. Employees have no policy on this bucket at all --
-- confirmed structurally impossible for an employee to reach an admin's
-- import source file.

NOTIFY pgrst, 'reload schema';
