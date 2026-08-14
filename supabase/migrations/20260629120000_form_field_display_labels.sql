-- Fix custom form field labels on expense detail/review (avoid generic "Field" fallback).

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
    coalesce(t.display_order, b.display_order, 0)::integer AS display_order
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
  'Saved custom field values with template/branch labels (name or field_key); org member access.';
