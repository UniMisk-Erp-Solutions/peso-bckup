-- ── PesoWise · CRITICAL FIX: batch-save RPC name was silently truncated
-- Migration: 20260822130000_fix_batch_save_function_name_truncation.sql
--
-- save_form_template_parent_option_configurations_batch_atomically is 64
-- characters. PostgreSQL identifiers are capped at 63 (NAMEDATALEN=64,
-- minus the null terminator) -- Postgres silently truncated it on CREATE
-- to save_form_template_parent_option_configurations_batch_atomicall (63
-- chars, missing the trailing "y"), with only a easily-missed NOTICE, not
-- an error. The REVOKE/GRANT/COMMENT statements for it in the same
-- migration also silently truncated to the identical name, so the SQL
-- file itself was internally self-consistent -- but every frontend call
-- via supabase.rpc("save_form_template_parent_option_configurations_batch_atomically", ...)
-- (the exact, untruncated name) has been failing with "function not
-- found" since that migration was applied. This is the root cause of
-- bulk import (and any Matrix/pending-changes save) silently not working.
--
-- Fix: create the SAME function body under a shorter name (50 chars,
-- safely under the limit), then drop both the mistakenly-truncated
-- function and the original (never-actually-live-under-that-name)
-- declaration. Frontend updated in the same commit to call the new name.

CREATE OR REPLACE FUNCTION public.save_form_template_parent_options_batch_atomically (
  p_organization_id  uuid,
  p_template_id       uuid,
  p_new_option_values text[],
  p_entries           jsonb,   -- [{parent_option_value, expected_fingerprint, branches}, ...]
  p_source             text DEFAULT 'bulk_import_batch',
  p_reason              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry           jsonb;
  v_option_value    text;
  v_result          jsonb;
  v_results         jsonb := '[]'::jsonb;
  v_new_added       integer := 0;
  v_current_options jsonb;
  v_lower_existing  text[];
  v_to_add          text[] := ARRAY[]::text[];
  v_candidate       text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id
      AND user_id         = auth.uid()
      AND is_active       = true
      AND role            = 'admin'
  ) THEN
    RAISE EXCEPTION 'Permission denied: admin role required in organisation %',
      p_organization_id;
  END IF;

  SELECT options INTO v_current_options
  FROM public.expense_form_field_templates
  WHERE id = p_template_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  IF p_entries IS NOT NULL AND jsonb_array_length(p_entries) > 300 THEN
    RAISE EXCEPTION
      'Too many options in one batch (%): max 300 — chunk the request',
      jsonb_array_length(p_entries);
  END IF;

  -- Append brand-new option values (case-insensitive dedupe against the
  -- template's current options[], matching create_form_template_parent_option's
  -- own dedupe rule), in one shot, before any per-option branch save runs.
  -- Runs UNCONDITIONALLY (even when p_entries is empty) so a caller can use
  -- this RPC purely to add option values with no branch data yet — e.g. a
  -- flat bulk import, which never touches branches at all.
  IF p_new_option_values IS NOT NULL AND array_length(p_new_option_values, 1) > 0 THEN
    SELECT array_agg(lower(opt)) INTO v_lower_existing
    FROM jsonb_array_elements_text(v_current_options) AS opt;
    v_lower_existing := COALESCE(v_lower_existing, ARRAY[]::text[]);

    FOREACH v_candidate IN ARRAY p_new_option_values LOOP
      v_candidate := trim(v_candidate);
      IF v_candidate <> '' AND NOT (lower(v_candidate) = ANY (v_lower_existing)) THEN
        v_to_add := array_append(v_to_add, v_candidate);
        v_lower_existing := array_append(v_lower_existing, lower(v_candidate));
      END IF;
    END LOOP;

    IF array_length(v_to_add, 1) > 0 THEN
      UPDATE public.expense_form_field_templates
      SET options = COALESCE(options, '[]'::jsonb) || to_jsonb(v_to_add),
          updated_at = now()
      WHERE id = p_template_id AND organization_id = p_organization_id;
      v_new_added := array_length(v_to_add, 1);
    END IF;
  END IF;

  IF p_entries IS NULL OR jsonb_array_length(p_entries) = 0 THEN
    RETURN jsonb_build_object('new_options_added', v_new_added, 'results', '[]'::jsonb);
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    v_option_value := v_entry->>'parent_option_value';
    BEGIN
      v_result := public.save_parent_option_branch_configuration_atomically(
        p_organization_id,
        p_template_id,
        v_option_value,
        NULLIF(v_entry->>'expected_fingerprint', ''),
        v_entry->'branches',
        p_source,
        p_reason
      );
      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'parent_option_value', v_option_value,
          'status',              'ok',
          'branches_inserted',   v_result->'branches_inserted',
          'branches_updated',    v_result->'branches_updated',
          'branches_retired',    v_result->'branches_retired'
        )
      );
    EXCEPTION WHEN OTHERS THEN
      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'parent_option_value', v_option_value,
          'status',              'error',
          'error_message',       SQLERRM
        )
      );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'new_options_added', v_new_added,
    'results',           v_results
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.save_form_template_parent_options_batch_atomically FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_form_template_parent_options_batch_atomically TO authenticated;

COMMENT ON FUNCTION public.save_form_template_parent_options_batch_atomically IS
  'Bulk-import/Matrix/preset parity fix (renamed from the 64-char '
  'save_form_template_parent_option_configurations_batch_atomically, which '
  'Postgres silently truncated to 63 chars on create, breaking every '
  'frontend call under its real name). Batched wrapper that calls '
  'save_parent_option_branch_configuration_atomically once per entry (its '
  'exact per-option safety scoping is reused unchanged, not duplicated), '
  'catching each entry''s own failure independently so a bulk import of '
  'N options reports partial success/failure instead of an all-or-nothing '
  'transaction. New option values are appended once, case-insensitively '
  'deduped, ahead of the per-option saves.';

-- Drop the mistakenly-truncated function this bug actually created, and the
-- (never-live-under-that-exact-name) original declaration, so nothing dead
-- or confusing is left behind.
DROP FUNCTION IF EXISTS public.save_form_template_parent_option_configurations_batch_atomicall(uuid, uuid, text[], jsonb, text, text);
DROP FUNCTION IF EXISTS public.save_form_template_parent_option_configurations_batch_atomically(uuid, uuid, text[], jsonb, text, text);

NOTIFY pgrst, 'reload schema';
