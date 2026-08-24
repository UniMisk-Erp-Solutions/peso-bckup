-- DOC-108 — bulk CSV/Excel import for admin-submit-on-behalf-of-employee.
--
-- Scope: backup instance only. Not for production until explicitly requested.
--
-- WHY THIS CALLS admin_submit_expense_for_employee_v1 RATHER THAN REPEATING ITS LOGIC
--   That function (DOC-107, 20260824100000_admin_submit_expense_for_employee.sql)
--   is already the single, tested source of truth for "one admin-submitted
--   expense done correctly" — authorization, field validation, the ported
--   hierarchy-routing engine, the two audit_logs rows, the notification
--   fan-out. It is left completely unmodified. This migration adds ONE new
--   function that loops a jsonb array and calls it once per row, exactly the
--   pattern already used in this codebase by
--   save_form_template_parent_option_configurations_batch_atomically
--   (20260822100000_form_template_bulk_batch_operations.sql): per-row
--   BEGIN/EXCEPTION isolation so one bad row cannot abort the batch, and a
--   loud upfront reject on an oversized batch rather than a silent partial
--   attempt.
--
-- WHY THE ADMIN CHECK IS ALSO DONE HERE, NOT LEFT TO THE INNER FUNCTION ALONE
--   admin_submit_expense_for_employee_v1 already rejects a non-admin caller —
--   but only after being invoked. Without an upfront check here, a non-admin
--   calling this in bulk would get N identical "not permitted" errors instead
--   of one clear failure, and the loop would do N wasted lookups first. This
--   function checks admin membership once before the loop.
--
-- WHY EMPLOYEE IDENTIFIER RESOLUTION LIVES HERE, NOT CLIENT-SIDE
--   profiles.employee_id has no UNIQUE constraint (verified against the live
--   schema) — a duplicate is a real possibility, not a theoretical one. Both
--   existing bulk-import precedents in this codebase (expenseImport.ts,
--   bulk-users-import) resolve "last match wins" and never surface an
--   ambiguous match. That is wrong for a payroll-adjacent feature: this
--   function treats zero matches and multiple matches as equally hard errors,
--   never silently picks one.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_bulk_submit_expenses_v1(
  p_organization_id uuid,
  p_rows            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_admin_id     uuid := auth.uid();
  v_row          jsonb;
  v_row_index    integer;
  v_employee_id  text;
  v_email        text;
  v_matches      uuid[];
  v_employee_uuid uuid;
  v_submit_result jsonb;
  v_results      jsonb := '[]'::jsonb;
  v_ok_count     integer := 0;
  v_fail_count   integer := 0;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE user_id = v_admin_id AND organization_id = p_organization_id
      AND role = 'admin' AND is_active = true
  ) THEN
    RAISE EXCEPTION 'not permitted: caller is not an active admin of this organization' USING ERRCODE = '42501';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a jsonb array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'rows is empty' USING ERRCODE = '22023';
  END IF;
  -- Client chunks a large import into groups of 200 (see bulkAdminSubmitExpenses.ts);
  -- this cap is a loud guard against an oversized single call, not the normal path.
  IF jsonb_array_length(p_rows) > 250 THEN
    RAISE EXCEPTION 'too many rows in one batch (%): max 250 — chunk the request', jsonb_array_length(p_rows)
      USING ERRCODE = '22023';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_row_index := (v_row->>'row_index')::integer;

    BEGIN
      v_employee_id := NULLIF(btrim(COALESCE(v_row->>'employee_id', '')), '');
      v_email       := NULLIF(btrim(COALESCE(v_row->>'email', '')), '');
      v_employee_uuid := NULL;
      v_matches := NULL;

      IF v_employee_id IS NOT NULL THEN
        SELECT array_agg(user_id) INTO v_matches
        FROM public.profiles
        WHERE organization_id = p_organization_id AND employee_id = v_employee_id;

        IF v_matches IS NULL OR array_length(v_matches, 1) = 0 THEN
          RAISE EXCEPTION 'no employee found with employee_id "%"', v_employee_id;
        ELSIF array_length(v_matches, 1) > 1 THEN
          RAISE EXCEPTION 'employee_id "%" matches % different people — fix the duplicate employee ID before retrying this row',
            v_employee_id, array_length(v_matches, 1);
        END IF;
        v_employee_uuid := v_matches[1];
      ELSIF v_email IS NOT NULL THEN
        SELECT array_agg(user_id) INTO v_matches
        FROM public.profiles
        WHERE organization_id = p_organization_id AND lower(email) = lower(v_email);

        IF v_matches IS NULL OR array_length(v_matches, 1) = 0 THEN
          RAISE EXCEPTION 'no employee found with email "%"', v_email;
        ELSIF array_length(v_matches, 1) > 1 THEN
          RAISE EXCEPTION 'email "%" matches % different people — fix the duplicate email before retrying this row',
            v_email, array_length(v_matches, 1);
        END IF;
        v_employee_uuid := v_matches[1];
      ELSE
        RAISE EXCEPTION 'row has neither employee_id nor email';
      END IF;

      -- Delegates entirely to the existing, tested single-row function: same
      -- validation, same hierarchy routing, same audit trail, same notifications.
      v_submit_result := public.admin_submit_expense_for_employee_v1(
        p_organization_id,
        v_employee_uuid,
        v_row->>'title',
        v_row->>'destination',
        (v_row->>'trip_start')::date,
        (v_row->>'trip_end')::date,
        v_row->>'category',
        (v_row->>'amount')::numeric,
        v_row->>'purpose'
      );

      v_ok_count := v_ok_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_index', v_row_index,
        'ok', true,
        'expense_id', v_submit_result->>'expense_id'
      ));
    EXCEPTION WHEN OTHERS THEN
      v_fail_count := v_fail_count + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row_index', v_row_index,
        'ok', false,
        'error', SQLERRM
      ));
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'total', jsonb_array_length(p_rows),
    'succeeded', v_ok_count,
    'failed', v_fail_count,
    'results', v_results
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.admin_bulk_submit_expenses_v1(uuid, jsonb) TO authenticated;

COMMIT;
