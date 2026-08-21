-- ── PesoWise · Form Field Template bulk-import/Matrix/preset parity on
-- ── server-paged (large) templates.
-- Migration: 20260822100000_form_template_bulk_batch_operations.sql
--
-- Restores bulk import, Matrix editing and reusable presets for an EXISTING
-- select/checkbox template WITHOUT reintroducing a full-template download.
-- The browser already knows (a) the full option VALUE list (it's already
-- loaded in expense_form_field_templates.options, a cheap short-string
-- array — never the scalability problem) and (b) the exact set of option
-- values TOUCHED by an import/Matrix page/preset action (a small subset of
-- a template that may have thousands of options). These two new RPCs let
-- it fetch and persist ONLY that touched subset's branch configuration in
-- one bounded, batched round trip instead of either (a) downloading every
-- option's branches to compare/edit locally, or (b) issuing one request per
-- touched option (an N+1 storm for a 500-row import).
--
-- Both RPCs are bounded to MAX_BATCH_SIZE = 300 option values per call —
-- the frontend chunks any larger set into sequential/limited-concurrency
-- batches rather than raising this cap.
--
-- NOT APPLIED to Production by this commit. Migration file + rollback only,
-- pending explicit owner authorization per this task's instructions.

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 7 — get_form_template_parent_option_configurations_batch (admin, read-only)
--
-- Same recursive-CTE branch fetch as get_form_template_parent_option_configuration,
-- generalised to N requested option values in one query. Each returned group
-- is tagged with the ROOT option value it belongs to (root_option_value,
-- carried through the recursion) so nested branches are bucketed under the
-- correct top-level option even though a nested branch's own
-- parent_option_value column holds the NESTED sub-choice, not the root's.
-- Requested values with zero branches still appear in the output with an
-- empty branches array and NULL fingerprint, so the caller can tell
-- "exists but unconfigured" apart from "wasn't returned".
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_form_template_parent_option_configurations_batch (
  p_organization_id      uuid,
  p_template_id          uuid,
  p_parent_option_values text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_configs jsonb;
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

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_templates
    WHERE id = p_template_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  IF p_parent_option_values IS NULL OR array_length(p_parent_option_values, 1) IS NULL THEN
    RETURN jsonb_build_object('configs', '[]'::jsonb);
  END IF;

  IF array_length(p_parent_option_values, 1) > 300 THEN
    RAISE EXCEPTION
      'Too many option values requested in one batch (%): max 300 — chunk the request',
      array_length(p_parent_option_values, 1);
  END IF;

  WITH RECURSIVE option_branches AS (
    SELECT
      b.*,
      b.parent_option_value AS root_option_value
    FROM public.expense_form_field_option_branches b
    WHERE  b.parent_template_id  = p_template_id
      AND  b.organization_id     = p_organization_id
      AND  b.parent_option_value = ANY (p_parent_option_values)
      AND  b.parent_branch_id    IS NULL
      AND  b.retired_at          IS NULL
    UNION ALL
    SELECT
      b.*,
      ob.root_option_value
    FROM public.expense_form_field_option_branches b
    JOIN option_branches ob ON b.parent_branch_id = ob.id
    WHERE b.retired_at IS NULL
  ),
  grouped AS (
    SELECT
      root_option_value,
      jsonb_agg(
        jsonb_build_object(
          'db_id',               id,
          'parent_branch_id',    parent_branch_id,
          'parent_option_value', parent_option_value,
          'field_key',           field_key,
          'name',                name,
          'field_type',          field_type,
          'required',            required,
          'placeholder',         placeholder,
          'help_text',           help_text,
          'options',             options,
          'display_order',       display_order
        )
        ORDER BY display_order
      ) AS branches,
      md5(string_agg(id::text || ':' || extract(epoch FROM updated_at)::text, ',' ORDER BY id)) AS fingerprint
    FROM option_branches
    GROUP BY root_option_value
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'parent_option_value',       ov,
      'branches',                  COALESCE(g.branches, '[]'::jsonb),
      'configuration_fingerprint', g.fingerprint
    )
  )
  INTO v_configs
  FROM unnest(p_parent_option_values) AS ov
  LEFT JOIN grouped g ON g.root_option_value = ov;

  RETURN jsonb_build_object('configs', COALESCE(v_configs, '[]'::jsonb));
END;
$$;

REVOKE ALL   ON FUNCTION public.get_form_template_parent_option_configurations_batch FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_form_template_parent_option_configurations_batch TO authenticated;

COMMENT ON FUNCTION public.get_form_template_parent_option_configurations_batch IS
  'Bulk-import/Matrix/preset parity fix. Fetches the branch trees for UP TO '
  '300 requested parent option values in one bounded query — never the '
  'whole template. Each result is tagged with root_option_value so nested '
  'branches bucket under the correct top-level option.';


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 8 — save_form_template_parent_option_configurations_batch_atomically (admin)
--
-- Batched wrapper around save_parent_option_branch_configuration_atomically
-- — reuses that function's exact per-option safety scoping by CALLING it
-- once per entry (no logic duplicated/re-derived here), inside a nested
-- BEGIN/EXCEPTION block so one option's failure (stale fingerprint,
-- duplicate key, missing required field, validation error) does not abort
-- the rest of the batch. Every entry is still fully atomic and
-- option-scoped on its own — this function only adds "keep going and
-- report partial results" around calls that were already individually
-- safe. New parent option values discovered by the import (not yet in
-- options[]) are appended once, case-insensitively deduped, in the same
-- transaction as the batch.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.save_form_template_parent_option_configurations_batch_atomically (
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

REVOKE ALL   ON FUNCTION public.save_form_template_parent_option_configurations_batch_atomically FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_form_template_parent_option_configurations_batch_atomically TO authenticated;

COMMENT ON FUNCTION public.save_form_template_parent_option_configurations_batch_atomically IS
  'Bulk-import/Matrix/preset parity fix. Batched wrapper that calls '
  'save_parent_option_branch_configuration_atomically once per entry (its '
  'exact per-option safety scoping is reused unchanged, not duplicated), '
  'catching each entry''s own failure independently so a bulk import of '
  'N options reports partial success/failure instead of an all-or-nothing '
  'transaction. New option values are appended once, case-insensitively '
  'deduped, ahead of the per-option saves.';


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 9 — rename_form_template_parent_option (admin)
--
-- UI parity fix: main's Parent Options tab lets an admin rename an option
-- inline. That only ever worked as a local-draft mutation persisted by a
-- whole-template save; this is the scoped equivalent for server-paged mode
-- -- updates the options[] entry and cascades parent_option_value on that
-- option's own ROOT branches only (nested branches key off their own
-- sub-choice value, never the top-level option, so they are untouched).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rename_form_template_parent_option (
  p_organization_id uuid,
  p_template_id     uuid,
  p_old_value       text,
  p_new_value       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_options          jsonb;
  v_old_trimmed      text := trim(p_old_value);
  v_new_trimmed      text := trim(p_new_value);
  v_old_exists       boolean;
  v_new_conflicts    boolean;
  v_next_options     jsonb;
  v_branches_updated integer;
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

  IF v_new_trimmed = '' THEN
    RAISE EXCEPTION 'New option value cannot be blank';
  END IF;

  SELECT options INTO v_options
  FROM public.expense_form_field_templates
  WHERE id = p_template_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_options) o WHERE o = v_old_trimmed)
  INTO v_old_exists;
  IF NOT v_old_exists THEN
    RAISE EXCEPTION 'Parent option "%" is not an active option on this template', v_old_trimmed;
  END IF;

  IF lower(v_old_trimmed) <> lower(v_new_trimmed) THEN
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_options) o WHERE lower(o) = lower(v_new_trimmed)
    ) INTO v_new_conflicts;
    IF v_new_conflicts THEN
      RAISE EXCEPTION 'Parent option "%" already exists on this template', v_new_trimmed
        USING ERRCODE = 'P0003';
    END IF;
  END IF;

  SELECT jsonb_agg(CASE WHEN o = v_old_trimmed THEN to_jsonb(v_new_trimmed) ELSE to_jsonb(o) END)
  INTO v_next_options
  FROM jsonb_array_elements_text(v_options) o;

  UPDATE public.expense_form_field_templates
  SET options = v_next_options, updated_at = now()
  WHERE id = p_template_id AND organization_id = p_organization_id;

  UPDATE public.expense_form_field_option_branches
  SET parent_option_value = v_new_trimmed, updated_at = now()
  WHERE parent_template_id  = p_template_id
    AND organization_id     = p_organization_id
    AND parent_option_value = v_old_trimmed
    AND parent_branch_id    IS NULL;

  GET DIAGNOSTICS v_branches_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true, 'old_value', v_old_trimmed, 'new_value', v_new_trimmed,
    'branches_updated', v_branches_updated
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.rename_form_template_parent_option FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rename_form_template_parent_option TO authenticated;

COMMENT ON FUNCTION public.rename_form_template_parent_option IS
  'Bulk-import/Matrix/preset parity fix. Scoped equivalent of main''s inline '
  'Parent Options rename -- updates options[] and cascades to that option''s '
  'own ROOT branches only.';


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 10 — delete_form_template_parent_option (admin)
--
-- UI parity fix: scoped equivalent of main's Parent Options trash-icon
-- delete. Removes the option from options[] and retires (never hard-deletes
-- -- matches the soft-delete convention every other mutation in this system
-- uses) every branch under that option, root and nested.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.delete_form_template_parent_option (
  p_organization_id uuid,
  p_template_id     uuid,
  p_option_value    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_options          jsonb;
  v_value_trimmed    text := trim(p_option_value);
  v_exists           boolean;
  v_next_options     jsonb;
  v_branches_retired integer;
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

  SELECT options INTO v_options
  FROM public.expense_form_field_templates
  WHERE id = p_template_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_options) o WHERE o = v_value_trimmed)
  INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'Parent option "%" is not an active option on this template', v_value_trimmed;
  END IF;

  SELECT jsonb_agg(to_jsonb(o)) INTO v_next_options
  FROM jsonb_array_elements_text(v_options) o
  WHERE o <> v_value_trimmed;

  UPDATE public.expense_form_field_templates
  SET options = COALESCE(v_next_options, '[]'::jsonb), updated_at = now()
  WHERE id = p_template_id AND organization_id = p_organization_id;

  UPDATE public.expense_form_field_option_branches
  SET retired_at     = now(),
      retired_by     = auth.uid(),
      retired_reason = 'parent_option_deleted',
      updated_at     = now()
  WHERE parent_template_id  = p_template_id
    AND organization_id     = p_organization_id
    AND parent_option_value = v_value_trimmed
    AND retired_at          IS NULL;

  GET DIAGNOSTICS v_branches_retired = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true, 'deleted_value', v_value_trimmed, 'branches_retired', v_branches_retired
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.delete_form_template_parent_option FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_form_template_parent_option TO authenticated;

COMMENT ON FUNCTION public.delete_form_template_parent_option IS
  'Bulk-import/Matrix/preset parity fix. Scoped equivalent of main''s Parent '
  'Options delete -- removes the option from options[] and retires (soft- '
  'deletes) every branch under it, root and nested.';

NOTIFY pgrst, 'reload schema';
