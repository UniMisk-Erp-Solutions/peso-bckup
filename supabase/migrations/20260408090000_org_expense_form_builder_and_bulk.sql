-- Org-customizable expense form controls + bulk-import support columns

-- 1) Organization-level configuration for built-in/base expense fields
CREATE TABLE IF NOT EXISTS public.organization_expense_form_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL CHECK (
    field_key IN ('category', 'title', 'destination', 'expense_date', 'purpose', 'amount')
  ),
  label TEXT NOT NULL,
  help_text TEXT,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  is_required BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  show_on_submit BOOLEAN NOT NULL DEFAULT true,
  show_on_review BOOLEAN NOT NULL DEFAULT true,
  show_on_detail BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_org_expense_form_fields_org_order
  ON public.organization_expense_form_fields (organization_id, display_order);

ALTER TABLE public.organization_expense_form_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view org expense form fields" ON public.organization_expense_form_fields;
CREATE POLICY "Org members can view org expense form fields"
  ON public.organization_expense_form_fields FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );

DROP POLICY IF EXISTS "Org admins can manage org expense form fields" ON public.organization_expense_form_fields;
CREATE POLICY "Org admins can manage org expense form fields"
  ON public.organization_expense_form_fields FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

-- 2) Extend dynamic template model to support stable keys and display controls
ALTER TABLE public.expense_form_field_templates
  ADD COLUMN IF NOT EXISTS field_key TEXT,
  ADD COLUMN IF NOT EXISTS section_name TEXT DEFAULT 'additional_information',
  ADD COLUMN IF NOT EXISTS show_on_submit BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_on_review BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_on_detail BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_form_template_org_field_key_unique
  ON public.expense_form_field_templates (organization_id, field_key)
  WHERE field_key IS NOT NULL;

-- 3) Extend assignment table with display controls and section override
ALTER TABLE public.expense_category_form_fields
  ADD COLUMN IF NOT EXISTS section_name TEXT,
  ADD COLUMN IF NOT EXISTS show_on_submit BOOLEAN,
  ADD COLUMN IF NOT EXISTS show_on_review BOOLEAN,
  ADD COLUMN IF NOT EXISTS show_on_detail BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_category_form_fields_org_display_order
  ON public.expense_category_form_fields (organization_id, display_order);

-- 3.1) Feature flags on organization settings for controlled rollout
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS enable_form_builder_v2 BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_bulk_imports BOOLEAN NOT NULL DEFAULT false;

-- 4) Seed defaults for organization base fields
INSERT INTO public.organization_expense_form_fields
  (organization_id, field_key, label, is_visible, is_required, display_order)
SELECT
  o.id,
  v.field_key,
  v.label,
  true,
  v.is_required,
  v.display_order
FROM public.organizations o
CROSS JOIN (
  VALUES
    ('category', 'Category', true, 10),
    ('title', 'Title', true, 20),
    ('destination', 'Vendor / Location', true, 30),
    ('expense_date', 'Expense Date', true, 40),
    ('purpose', 'Purpose', false, 50),
    ('amount', 'Amount', true, 60)
) AS v(field_key, label, is_required, display_order)
ON CONFLICT (organization_id, field_key) DO NOTHING;

-- 5) Trigger for updated_at on org base field config
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_org_expense_form_fields_updated_at'
  ) THEN
    CREATE TRIGGER update_org_expense_form_fields_updated_at
      BEFORE UPDATE ON public.organization_expense_form_fields
      FOR EACH ROW
      EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;
