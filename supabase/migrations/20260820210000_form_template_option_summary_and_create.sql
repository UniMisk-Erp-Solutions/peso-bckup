-- ── PesoWise · HOTFIX: lightweight editor summary + add-option RPC
-- Migration: 20260820210000_form_template_option_summary_and_create.sql
--
-- Continues 20260820200000_form_template_server_pagination.sql. The real
-- FormFieldTemplateEditorDialog can now open an EXISTING select/checkbox
-- template WITHOUT loading its options[] array or any branch rows — this
-- migration adds the two remaining pieces:
--   4. get_form_template_editor_summary — tiny aggregate counts for the
--      dialog's header badges.
--   5. create_form_template_parent_option — appends one value to
--      options[] server-side without downloading the existing ~500+ values.
--
-- Ported from the proven prototype on debug/category-server-search-pagination
-- (20260819100000_debug_category_v2_summary_and_add_option.sql, never
-- applied to Production).

CREATE OR REPLACE FUNCTION public.get_form_template_editor_summary (
  p_organization_id uuid,
  p_template_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_required_keys      text[] := ARRAY[]::text[];
  v_parent_option_count integer;
  v_template_updated_at timestamptz;
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

  SELECT jsonb_array_length(COALESCE(t.options, '[]'::jsonb)), t.updated_at
  INTO   v_parent_option_count, v_template_updated_at
  FROM   public.expense_form_field_templates t
  WHERE  t.id = p_template_id AND t.organization_id = p_organization_id;

  IF v_parent_option_count IS NULL AND v_template_updated_at IS NULL THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  IF p_template_id = '51181324-68cc-4174-bbe0-4834e5e22c48'::uuid THEN
    v_required_keys := ARRAY['project_id', 'project_name'];
  END IF;

  SELECT v_required_keys || COALESCE(array_agg(DISTINCT elem->>'field_key'), ARRAY[]::text[])
  INTO   v_required_keys
  FROM   public.expense_form_field_branch_presets p,
         jsonb_array_elements(p.field_schema) AS elem
  WHERE  p.organization_id              = p_organization_id
    AND  p.parent_template_id           = p_template_id
    AND  p.is_default                   = true
    AND  p.enforce_on_all_parent_options = true
    AND  (elem->>'required')::boolean   = true;

  SELECT array_agg(DISTINCT k) INTO v_required_keys FROM unnest(v_required_keys) AS k;
  v_required_keys := COALESCE(v_required_keys, ARRAY[]::text[]);

  RETURN (
    WITH opts AS (
      SELECT opt FROM public.expense_form_field_templates t,
             jsonb_array_elements_text(t.options) AS opt
      WHERE t.id = p_template_id AND t.organization_id = p_organization_id
    ),
    active_branches AS (
      SELECT * FROM public.expense_form_field_option_branches
      WHERE parent_template_id = p_template_id
        AND organization_id    = p_organization_id
        AND retired_at         IS NULL
    ),
    root_keys AS (
      SELECT parent_option_value, array_agg(DISTINCT field_key) AS keys
      FROM   active_branches
      WHERE  parent_branch_id IS NULL
      GROUP BY parent_option_value
    ),
    configured AS (
      SELECT DISTINCT parent_option_value FROM active_branches WHERE parent_branch_id IS NULL
    )
    SELECT jsonb_build_object(
      'parent_option_count',            v_parent_option_count,
      'configured_parent_option_count', (SELECT count(*) FROM configured c WHERE c.parent_option_value IN (SELECT opt FROM opts)),
      'active_root_branch_count',       (SELECT count(*) FROM active_branches WHERE parent_branch_id IS NULL),
      'active_nested_branch_count',     (SELECT count(*) FROM active_branches WHERE parent_branch_id IS NOT NULL),
      'total_active_branch_count',      (SELECT count(*) FROM active_branches),
      'incomplete_option_count',
        CASE WHEN array_length(v_required_keys, 1) IS NULL THEN 0
        ELSE (
          SELECT count(*) FROM opts o
          WHERE NOT EXISTS (
            SELECT 1 FROM root_keys rk
            WHERE rk.parent_option_value = o.opt AND rk.keys @> v_required_keys
          )
        )
        END,
      'legacy_orphan_group_count',
        (SELECT count(DISTINCT parent_option_value) FROM active_branches
         WHERE parent_branch_id IS NULL AND parent_option_value NOT IN (SELECT opt FROM opts)),
      'template_updated_at', v_template_updated_at
    )
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.get_form_template_editor_summary FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_form_template_editor_summary TO authenticated;

COMMENT ON FUNCTION public.get_form_template_editor_summary IS
  'DOC-097 hotfix. Tiny aggregate summary for the editor header badges. '
  'Never returns branch rows or the options array itself.';


CREATE OR REPLACE FUNCTION public.create_form_template_parent_option (
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
  v_trimmed        text := trim(COALESCE(p_option_value, ''));
  v_existing_count integer;
  v_new_count      integer;
BEGIN
  IF v_trimmed = '' THEN
    RAISE EXCEPTION 'Parent option value cannot be blank';
  END IF;

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

  PERFORM 1 FROM public.expense_form_field_templates
  WHERE id = p_template_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  SELECT count(*) INTO v_existing_count
  FROM public.expense_form_field_templates t,
       jsonb_array_elements_text(t.options) AS opt
  WHERE t.id = p_template_id AND t.organization_id = p_organization_id
    AND lower(opt) = lower(v_trimmed);

  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'duplicate_parent_option: "%" already exists on this template', v_trimmed
      USING ERRCODE = 'P0003';
  END IF;

  UPDATE public.expense_form_field_templates
  SET options    = COALESCE(options, '[]'::jsonb) || to_jsonb(v_trimmed),
      updated_at = now()
  WHERE id = p_template_id AND organization_id = p_organization_id
  RETURNING jsonb_array_length(options) INTO v_new_count;

  RETURN jsonb_build_object(
    'ok', true,
    'option_value', v_trimmed,
    'display_index', v_new_count,
    'parent_option_count', v_new_count
  );
END;
$$;

REVOKE ALL   ON FUNCTION public.create_form_template_parent_option FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_form_template_parent_option TO authenticated;

COMMENT ON FUNCTION public.create_form_template_parent_option IS
  'DOC-097 hotfix. Appends one value to a template''s options[] array '
  'server-side. Case-insensitive duplicate check. Does not touch branch rows.';

NOTIFY pgrst, 'reload schema';
