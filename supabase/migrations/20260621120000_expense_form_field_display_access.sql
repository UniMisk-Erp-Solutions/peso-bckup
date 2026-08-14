-- Allow reading custom form field values whenever the caller can SELECT the parent expense.
-- The original policy only covered expense owners, assigned_engineer_id, and org admins
-- (via organization_memberships). Reviewers (assigned_reviewer_id), cashiers with expense
-- access, and legacy has_role('admin') users could see the expense row but got zero form values.

DROP POLICY IF EXISTS "View form field values for visible expenses" ON public.expense_form_field_values;

CREATE POLICY "View form field values for visible expenses"
  ON public.expense_form_field_values
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.expenses e
      WHERE e.id = expense_form_field_values.expense_id
        AND e.organization_id = expense_form_field_values.organization_id
    )
  );

COMMENT ON POLICY "View form field values for visible expenses" ON public.expense_form_field_values IS
  'Form values inherit visibility from expenses RLS (subquery on expenses is policy-filtered).';

-- SECURITY DEFINER fallback for clients when template joins fail or for consistent labels.
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
DECLARE
  v_context text := lower(trim(coalesce(p_context, 'review')));
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
    coalesce(t.name, b.name, 'Field') AS name,
    coalesce(t.field_type, b.field_type, 'text') AS field_type,
    v.field_value,
    coalesce(t.display_order, b.display_order, 0)::integer AS display_order
  FROM public.expense_form_field_values v
  LEFT JOIN public.expense_form_field_templates t
    ON t.id = v.template_id
   AND t.organization_id = p_organization_id
  LEFT JOIN public.expense_form_field_option_branches b
    ON b.id = v.branch_field_id
   AND b.organization_id = p_organization_id
  WHERE v.expense_id = p_expense_id
    AND v.organization_id = p_organization_id
    AND (
      v.template_id IS NULL
      OR v_context <> 'review'
      OR coalesce(t.show_on_review, true) = true
    )
    AND (
      v.template_id IS NULL
      OR v_context <> 'detail'
      OR coalesce(t.show_on_detail, true) = true
    )
  ORDER BY display_order, name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_expense_form_field_display(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_expense_form_field_display(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_expense_form_field_display(uuid, uuid, text) IS
  'Review/detail custom field values with template/branch labels; org member + expense must exist.';
