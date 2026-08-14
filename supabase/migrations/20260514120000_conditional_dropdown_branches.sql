-- Tiered dropdown option branches: child field defs per parent select option.

CREATE TABLE IF NOT EXISTS public.expense_form_field_option_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  parent_template_id uuid NOT NULL REFERENCES public.expense_form_field_templates (id) ON DELETE CASCADE,
  parent_option_value text NOT NULL,
  parent_branch_id uuid REFERENCES public.expense_form_field_option_branches (id) ON DELETE CASCADE,
  field_key text NOT NULL,
  name text NOT NULL,
  field_type text NOT NULL CHECK (
    field_type IN ('text', 'number', 'date', 'textarea', 'select', 'checkbox')
  ),
  required boolean NOT NULL DEFAULT false,
  placeholder text,
  help_text text,
  default_value text,
  validation_rules jsonb,
  options jsonb,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_option_branches_parent_template
  ON public.expense_form_field_option_branches (parent_template_id, parent_option_value);

CREATE INDEX IF NOT EXISTS idx_option_branches_parent_branch
  ON public.expense_form_field_option_branches (parent_branch_id)
  WHERE parent_branch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_option_branches_root_field_key
  ON public.expense_form_field_option_branches (parent_template_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_option_branches_nested_field_key
  ON public.expense_form_field_option_branches (parent_branch_id, parent_option_value, field_key)
  WHERE parent_branch_id IS NOT NULL;

COMMENT ON TABLE public.expense_form_field_option_branches IS
  'Child form fields shown when a parent select option (or nested select option) is chosen.';

-- Extend values: branch_field_id OR template_id
ALTER TABLE public.expense_form_field_values
  ALTER COLUMN template_id DROP NOT NULL;

ALTER TABLE public.expense_form_field_values
  ADD COLUMN IF NOT EXISTS branch_field_id uuid REFERENCES public.expense_form_field_option_branches (id) ON DELETE CASCADE;

ALTER TABLE public.expense_form_field_values
  DROP CONSTRAINT IF EXISTS expense_form_field_values_expense_id_template_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_form_field_values_expense_template
  ON public.expense_form_field_values (expense_id, template_id)
  WHERE template_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_form_field_values_expense_branch
  ON public.expense_form_field_values (expense_id, branch_field_id)
  WHERE branch_field_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expense_form_field_values_template_or_branch'
  ) THEN
    ALTER TABLE public.expense_form_field_values
      ADD CONSTRAINT expense_form_field_values_template_or_branch CHECK (
        (template_id IS NOT NULL AND branch_field_id IS NULL)
        OR (template_id IS NULL AND branch_field_id IS NOT NULL)
      );
  END IF;
END $$;

ALTER TABLE public.expense_form_field_option_branches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view option branches" ON public.expense_form_field_option_branches;
CREATE POLICY "Org members can view option branches"
  ON public.expense_form_field_option_branches FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can manage option branches" ON public.expense_form_field_option_branches;
CREATE POLICY "Admins can manage option branches"
  ON public.expense_form_field_option_branches FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

DROP TRIGGER IF EXISTS update_option_branches_updated_at ON public.expense_form_field_option_branches;
CREATE TRIGGER update_option_branches_updated_at
  BEFORE UPDATE ON public.expense_form_field_option_branches
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
