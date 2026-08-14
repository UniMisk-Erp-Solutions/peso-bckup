-- Custom form fields: review/detail display + reliable upsert on self-hosted DB.
-- Safe to run once on prod even if earlier 20260621* migrations were applied.

-- ---------------------------------------------------------------------------
-- 1) RLS: form values visible when parent expense is visible
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "View form field values for visible expenses" ON public.expense_form_field_values;

CREATE POLICY "View form field values for visible expenses"
  ON public.expense_form_field_values
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.expenses e
      WHERE e.id = expense_form_field_values.expense_id
        AND (
          expense_form_field_values.organization_id IS NULL
          OR e.organization_id = expense_form_field_values.organization_id
        )
    )
  );

COMMENT ON POLICY "View form field values for visible expenses" ON public.expense_form_field_values IS
  'Form values inherit visibility from expenses RLS.';

-- ---------------------------------------------------------------------------
-- 2) Upsert target for template values (PostgREST on_conflict)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_field_values_expense_template
  ON public.expense_form_field_values (expense_id, template_id)
  WHERE template_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_form_field_values_expense_branch
  ON public.expense_form_field_values (expense_id, branch_field_id)
  WHERE branch_field_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) RPC: labels + values for review/detail (SECURITY DEFINER)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_expense_form_field_display(uuid, uuid, text);

CREATE FUNCTION public.get_expense_form_field_display(
  p_organization_id uuid,
  p_expense_id uuid,
  p_context text DEFAULT 'review'
)
RETURNS TABLE(
  id uuid,
  name text,
  field_type text,
  field_value text,
  display_order integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_organization_id IS NULL OR p_expense_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.expenses e
    WHERE e.id = p_expense_id
      AND e.organization_id = p_organization_id
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = p_organization_id
      AND om.is_active = true
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    v.id,
    coalesce(
      nullif(trim(t.name), ''),
      nullif(trim(b.name), ''),
      nullif(trim(t.field_key), ''),
      nullif(trim(b.field_key), ''),
      initcap(replace(nullif(trim(coalesce(t.field_key, b.field_key)), ''), '_', ' ')),
      'Field'
    ) AS name,
    coalesce(t.field_type, b.field_type, 'text') AS field_type,
    v.field_value,
    coalesce(
      (
        SELECT min(cc.display_order)
        FROM public.expense_category_form_fields cc
        WHERE cc.template_id = t.id
          AND cc.organization_id = p_organization_id
      ),
      b.display_order,
      0
    )::integer AS display_order
  FROM public.expense_form_field_values v
  LEFT JOIN public.expense_form_field_templates t
    ON t.id = v.template_id
  LEFT JOIN public.expense_form_field_option_branches b
    ON b.id = v.branch_field_id
  WHERE v.expense_id = p_expense_id
    AND (
      v.organization_id = p_organization_id
      OR v.organization_id IS NULL
    )
  ORDER BY display_order, name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_expense_form_field_display(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expense_form_field_display(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_expense_form_field_display(uuid, uuid, text) IS
  'All saved custom field values with template/branch labels; org member access.';
