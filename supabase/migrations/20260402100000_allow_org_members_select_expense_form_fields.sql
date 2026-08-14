DO $$
BEGIN
  -- If tables don't exist in this environment, exit gracefully.
  IF to_regclass('public.expense_form_field_templates') IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('public.expense_category_form_fields') IS NULL THEN
    RETURN;
  END IF;

  /*
    CURRENT ISSUE:
    The original policies in `20250130000004_create_expense_form_fields.sql`
    allow SELECT on:
      - public.expense_form_field_templates
      - public.expense_category_form_fields
    ONLY for org members with role = 'admin'.

    Result:
      employees/engineers can't fetch the template definitions/assignments,
      so the UI never renders the "Additional Information" block.
  */

  -- Allow any active organization member to view templates.
  DROP POLICY IF EXISTS "Org members can view form field templates" ON public.expense_form_field_templates;
  CREATE POLICY "Org members can view form field templates"
    ON public.expense_form_field_templates
    FOR SELECT
    USING (
      organization_id IN (
        SELECT organization_id
        FROM public.organization_memberships
        WHERE user_id = auth.uid()
          AND is_active = true
      )
    );

  -- Allow any active organization member to view category-to-template assignments.
  DROP POLICY IF EXISTS "Org members can view category form field assignments" ON public.expense_category_form_fields;
  CREATE POLICY "Org members can view category form field assignments"
    ON public.expense_category_form_fields
    FOR SELECT
    USING (
      organization_id IN (
        SELECT organization_id
        FROM public.organization_memberships
        WHERE user_id = auth.uid()
          AND is_active = true
      )
    );
END $$;

