-- ── PesoWise · HOTFIX pt.3: legacy orphan inspector (admin, read-only) +
-- ── employee-safe runtime search + recents
-- Migration: 20260821110000_form_template_orphan_inspector_and_runtime_search.sql
--
-- Three new, purely additive RPCs. None mutate anything -- read-only
-- throughout, matching Part 32's explicit "do not repair" instruction.

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 6 — get_form_template_legacy_orphan_groups (admin, read-only)
--
-- Lists every ACTIVE root branch group whose parent_option_value is no
-- longer present in the template's current options[] -- the exact set the
-- editor summary's legacy_orphan_group_count already counts, now inspectable.
-- No delete/restore/repair capability exists here or anywhere in this
-- migration.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_form_template_legacy_orphan_groups (
  p_organization_id uuid,
  p_template_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_groups jsonb;
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
  orphan_roots AS (
    SELECT DISTINCT parent_option_value
    FROM active_branches
    WHERE parent_branch_id IS NULL
      AND parent_option_value NOT IN (SELECT opt FROM opts)
  ),
  orphan_all_branches AS (
    SELECT ab.* FROM active_branches ab
    JOIN orphan_roots orr ON orr.parent_option_value = ab.parent_option_value
  ),
  fields_agg AS (
    SELECT parent_option_value,
           jsonb_agg(
             jsonb_build_object(
               'field_key',   field_key,
               'name',        name,
               'is_nested',   parent_branch_id IS NOT NULL,
               'created_at',  created_at,
               'updated_at',  updated_at
             )
             ORDER BY display_order
           ) AS fields,
           count(*) FILTER (WHERE parent_branch_id IS NULL) AS root_count,
           count(*) FILTER (WHERE parent_branch_id IS NOT NULL) AS nested_count,
           min(created_at) AS earliest_created_at,
           max(updated_at) AS latest_updated_at
    FROM orphan_all_branches
    GROUP BY parent_option_value
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'parent_option_value', parent_option_value,
      'root_branch_count',   root_count,
      'nested_branch_count', nested_count,
      'fields',              fields,
      'earliest_created_at', earliest_created_at,
      'latest_updated_at',   latest_updated_at
    )
    ORDER BY parent_option_value
  )
  INTO v_groups
  FROM fields_agg;

  RETURN jsonb_build_object('groups', COALESCE(v_groups, '[]'::jsonb));
END;
$$;

REVOKE ALL   ON FUNCTION public.get_form_template_legacy_orphan_groups FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_form_template_legacy_orphan_groups TO authenticated;

COMMENT ON FUNCTION public.get_form_template_legacy_orphan_groups IS
  'DOC-097 hotfix pt.3. Admin-only, READ-ONLY inspection of active branch '
  'groups whose parent_option_value is no longer in the template''s current '
  'options[]. No delete/restore/repair capability -- inspection only.';


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 7 — search_runtime_form_template_parent_options_v1 (employee-safe)
--
-- Bounded (<=20 results) search for the runtime combobox. Searches option
-- value AND preview field values, same generic rule as the admin search.
-- Employee-safe: any active org member, not admin-only. Organization is
-- independently re-derived from the caller's own membership, never trusted
-- from the browser alone -- p_organization_id (if supplied) is verified to
-- match, not assumed.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.search_runtime_form_template_parent_options_v1 (
  p_organization_id uuid,
  p_template_id     uuid,
  p_query           text    DEFAULT NULL,
  p_limit           integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit   integer := LEAST(20, GREATEST(1, COALESCE(p_limit, 20)));
  v_query   text    := NULLIF(trim(COALESCE(p_query, '')), '');
  v_results jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id
      AND user_id         = auth.uid()
      AND is_active       = true
  ) THEN
    RAISE EXCEPTION 'Permission denied: active membership required in organisation %',
      p_organization_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.expense_form_field_templates
    WHERE id = p_template_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Template % not found for organisation %',
      p_template_id, p_organization_id;
  END IF;

  WITH tmpl_opts AS (
    SELECT opt, ord
    FROM   public.expense_form_field_templates t,
           LATERAL jsonb_array_elements_text(t.options) WITH ORDINALITY AS x(opt, ord)
    WHERE  t.id = p_template_id AND t.organization_id = p_organization_id
  ),
  root_branches AS (
    SELECT
      parent_option_value, field_key, name, display_order,
      CASE
        WHEN field_type IN ('select', 'checkbox')
             AND jsonb_typeof(options) = 'array'
             AND jsonb_array_length(options) = 1
        THEN options ->> 0
        ELSE default_value
      END AS preview_value
    FROM public.expense_form_field_option_branches
    WHERE parent_template_id = p_template_id
      AND organization_id    = p_organization_id
      AND retired_at         IS NULL
      AND parent_branch_id   IS NULL
  ),
  root_branches_ranked AS (
    SELECT *, row_number() OVER (PARTITION BY parent_option_value ORDER BY display_order) AS rn
    FROM root_branches
  ),
  preview_agg AS (
    SELECT parent_option_value,
           jsonb_agg(
             jsonb_build_object('field_key', field_key, 'name', name, 'value', preview_value)
             ORDER BY display_order
           ) AS preview_fields
    FROM root_branches_ranked
    WHERE rn <= 2
    GROUP BY parent_option_value
  ),
  value_matches AS (
    SELECT DISTINCT parent_option_value
    FROM root_branches
    WHERE v_query IS NOT NULL AND preview_value ILIKE ('%' || v_query || '%')
  ),
  filtered AS (
    SELECT opt, ord FROM tmpl_opts
    WHERE v_query IS NULL
       OR opt ILIKE ('%' || v_query || '%')
       OR opt IN (SELECT parent_option_value FROM value_matches)
    ORDER BY ord
    LIMIT v_limit
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'option_value',   f.opt,
      'preview_fields', COALESCE(pa.preview_fields, '[]'::jsonb)
    )
    ORDER BY f.ord
  )
  INTO v_results
  FROM filtered f
  LEFT JOIN preview_agg pa ON pa.parent_option_value = f.opt;

  RETURN jsonb_build_object('results', COALESCE(v_results, '[]'::jsonb));
END;
$$;

REVOKE ALL   ON FUNCTION public.search_runtime_form_template_parent_options_v1 FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.search_runtime_form_template_parent_options_v1 FROM anon;
GRANT EXECUTE ON FUNCTION public.search_runtime_form_template_parent_options_v1 TO authenticated;

COMMENT ON FUNCTION public.search_runtime_form_template_parent_options_v1 IS
  'DOC-097 hotfix pt.3. Employee-safe (any active org member), bounded '
  '(<=20) runtime search for the expense-form combobox. Never downloads all '
  'options or any branch tree -- selecting a result still requires a '
  'separate get_runtime_form_option_configuration call.';


-- ═══════════════════════════════════════════════════════════════════════════
-- RPC 8 — get_my_recent_form_template_options_v1 (own-user-only)
--
-- The caller's own most-recently-used, distinct, still-active parent option
-- values for this template, derived from their own expenses'
-- expense_form_field_values (covers both normal and batch expense entry --
-- a batch line is itself a row in `expenses`, so no special-casing is
-- needed). Never another employee's history, never cross-org.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_my_recent_form_template_options_v1 (
  p_organization_id uuid,
  p_template_id     uuid,
  p_limit           integer DEFAULT 4
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_limit  integer := LEAST(10, GREATEST(1, COALESCE(p_limit, 4)));
  v_results jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE organization_id = p_organization_id
      AND user_id         = v_uid
      AND is_active       = true
  ) THEN
    RAISE EXCEPTION 'Permission denied: active membership required in organisation %',
      p_organization_id;
  END IF;

  WITH tmpl_opts AS (
    SELECT opt FROM public.expense_form_field_templates t,
      jsonb_array_elements_text(t.options) AS opt
    WHERE t.id = p_template_id AND t.organization_id = p_organization_id
  ),
  root_branches AS (
    SELECT
      parent_option_value, field_key, name, display_order,
      CASE
        WHEN field_type IN ('select', 'checkbox')
             AND jsonb_typeof(options) = 'array'
             AND jsonb_array_length(options) = 1
        THEN options ->> 0
        ELSE default_value
      END AS preview_value
    FROM public.expense_form_field_option_branches
    WHERE parent_template_id = p_template_id
      AND organization_id    = p_organization_id
      AND retired_at         IS NULL
      AND parent_branch_id   IS NULL
  ),
  root_branches_ranked AS (
    SELECT *, row_number() OVER (PARTITION BY parent_option_value ORDER BY display_order) AS rn
    FROM root_branches
  ),
  preview_agg AS (
    SELECT parent_option_value,
           jsonb_agg(
             jsonb_build_object('field_key', field_key, 'name', name, 'value', preview_value)
             ORDER BY display_order
           ) AS preview_fields
    FROM root_branches_ranked
    WHERE rn <= 2
    GROUP BY parent_option_value
  ),
  my_usage AS (
    SELECT efv.field_value AS option_value, max(e.created_at) AS last_used_at
    FROM public.expense_form_field_values efv
    JOIN public.expenses e ON e.id = efv.expense_id
    WHERE efv.template_id     = p_template_id
      AND efv.organization_id = p_organization_id
      AND e.user_id            = v_uid
      AND e.organization_id    = p_organization_id
    GROUP BY efv.field_value
  ),
  usage_still_valid AS (
    SELECT mu.option_value, mu.last_used_at
    FROM my_usage mu
    WHERE mu.option_value IN (SELECT opt FROM tmpl_opts)
    ORDER BY mu.last_used_at DESC
    LIMIT v_limit
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'option_value',   uv.option_value,
      'last_used_at',   uv.last_used_at,
      'preview_fields', COALESCE(pa.preview_fields, '[]'::jsonb)
    )
    ORDER BY uv.last_used_at DESC
  )
  INTO v_results
  FROM usage_still_valid uv
  LEFT JOIN preview_agg pa ON pa.parent_option_value = uv.option_value;

  RETURN jsonb_build_object('results', COALESCE(v_results, '[]'::jsonb));
END;
$$;

REVOKE ALL   ON FUNCTION public.get_my_recent_form_template_options_v1 FROM PUBLIC;
REVOKE ALL   ON FUNCTION public.get_my_recent_form_template_options_v1 FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_recent_form_template_options_v1 TO authenticated;

COMMENT ON FUNCTION public.get_my_recent_form_template_options_v1 IS
  'DOC-097 hotfix pt.3. The caller''s own (auth.uid()-scoped) most-recently- '
  'used, distinct, still-active parent option values for a template, '
  'derived from their own expenses'' form field values. Never another '
  'user''s history, never cross-org. Clamped to 1-10, default 4.';

NOTIFY pgrst, 'reload schema';
