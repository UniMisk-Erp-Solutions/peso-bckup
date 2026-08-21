-- Rollback for 20260822120000_form_template_search_configured_only_filter.sql
-- Restores the exact prior body from 20260821100000_form_template_search_preview_fields.sql
-- (5-param signature, no p_configured_only).
CREATE OR REPLACE FUNCTION public.search_form_template_parent_options (
  p_organization_id uuid,
  p_template_id     uuid,
  p_query           text    DEFAULT NULL,
  p_page            integer DEFAULT 1,
  p_page_size       integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_page          integer := GREATEST(1, COALESCE(p_page, 1));
  v_page_size     integer := LEAST(100, GREATEST(1, COALESCE(p_page_size, 25)));
  v_query         text    := NULLIF(trim(COALESCE(p_query, '')), '');
  v_required_keys text[]  := ARRAY[]::text[];
  v_results       jsonb;
  v_total         integer := 0;
  v_total_pages   integer;
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

  WITH tmpl_opts AS (
    SELECT opt, ord
    FROM   public.expense_form_field_templates t,
           LATERAL jsonb_array_elements_text(t.options) WITH ORDINALITY AS x(opt, ord)
    WHERE  t.id = p_template_id AND t.organization_id = p_organization_id
  ),
  root_branches AS (
    SELECT
      parent_option_value,
      field_key,
      name,
      display_order,
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
  ),
  branch_agg AS (
    SELECT parent_option_value,
           count(*) FILTER (WHERE parent_branch_id IS NULL) AS root_count,
           count(*)                                          AS total_count
    FROM   public.expense_form_field_option_branches
    WHERE  parent_template_id = p_template_id
      AND  organization_id    = p_organization_id
      AND  retired_at         IS NULL
    GROUP BY parent_option_value
  ),
  root_keys AS (
    SELECT parent_option_value, array_agg(DISTINCT field_key) AS keys
    FROM   public.expense_form_field_option_branches
    WHERE  parent_template_id = p_template_id
      AND  organization_id    = p_organization_id
      AND  retired_at         IS NULL
      AND  parent_branch_id   IS NULL
    GROUP BY parent_option_value
  ),
  paged AS (
    SELECT f.opt, f.ord, count(*) OVER () AS total_matching
    FROM   filtered f
    ORDER BY f.ord
    OFFSET (v_page - 1) * v_page_size
    LIMIT  v_page_size
  )
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'option_value',             p.opt,
        'display_index',            p.ord,
        'active_root_branch_count', COALESCE(ba.root_count, 0),
        'active_total_branch_count',COALESCE(ba.total_count, 0),
        'configured',               COALESCE(ba.root_count, 0) > 0,
        'integrity_status',
          CASE
            WHEN array_length(v_required_keys, 1) IS NULL THEN 'not_applicable'
            WHEN rk.keys IS NOT NULL AND rk.keys @> v_required_keys THEN 'complete'
            ELSE 'incomplete'
          END,
        'preview_fields', COALESCE(pa.preview_fields, '[]'::jsonb)
      )
      ORDER BY p.ord
    ),
    COALESCE(max(p.total_matching), 0)
  INTO   v_results, v_total
  FROM   paged p
  LEFT JOIN branch_agg  ba ON ba.parent_option_value = p.opt
  LEFT JOIN root_keys   rk ON rk.parent_option_value = p.opt
  LEFT JOIN preview_agg pa ON pa.parent_option_value = p.opt;

  v_total_pages := GREATEST(1, ceil(v_total::numeric / v_page_size)::integer);

  RETURN jsonb_build_object(
    'results',       COALESCE(v_results, '[]'::jsonb),
    'page',           v_page,
    'page_size',      v_page_size,
    'total_results',  v_total,
    'total_pages',    v_total_pages,
    'has_previous',   v_page > 1,
    'has_next',       v_page < v_total_pages
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
