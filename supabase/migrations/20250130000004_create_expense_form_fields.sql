-- Create tables for custom form fields in expense categories
-- This enables admins to add required form fields to categories (e.g., odometer reading for fuel)

-- ============================================================================
-- PART 1: CREATE FORM FIELD TEMPLATES TABLE
-- ============================================================================
-- Reusable templates that can be assigned to multiple categories
CREATE TABLE IF NOT EXISTS public.expense_form_field_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL, -- Field name (e.g., "Odometer Reading")
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'textarea', 'select', 'checkbox')),
  required BOOLEAN DEFAULT false,
  default_value TEXT,
  placeholder TEXT,
  help_text TEXT,
  -- Validation rules (stored as JSON for flexibility)
  validation_rules JSONB, -- e.g., {"min": 0, "max": 999999, "pattern": "..."}
  -- For select/dropdown: options stored as JSON array
  options JSONB, -- e.g., ["Option 1", "Option 2"] for select type
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add comment
COMMENT ON TABLE public.expense_form_field_templates IS 'Reusable form field templates that can be assigned to multiple categories';

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_form_field_templates_org ON public.expense_form_field_templates(organization_id);

-- ============================================================================
-- PART 2: CREATE CATEGORY-FIELD ASSIGNMENTS TABLE
-- ============================================================================
-- Links form field templates to categories
CREATE TABLE IF NOT EXISTS public.expense_category_form_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  category_id UUID REFERENCES public.expense_categories(id) ON DELETE CASCADE NOT NULL,
  template_id UUID REFERENCES public.expense_form_field_templates(id) ON DELETE CASCADE NOT NULL,
  -- Category-specific overrides (optional)
  required BOOLEAN, -- Override template required setting
  display_order INTEGER DEFAULT 0, -- Order in which fields appear
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(category_id, template_id) -- Prevent duplicate assignments
);

-- Add comment
COMMENT ON TABLE public.expense_category_form_fields IS 'Assigns form field templates to expense categories';

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_category_form_fields_category ON public.expense_category_form_fields(category_id);
CREATE INDEX IF NOT EXISTS idx_category_form_fields_template ON public.expense_category_form_fields(template_id);
CREATE INDEX IF NOT EXISTS idx_category_form_fields_org ON public.expense_category_form_fields(organization_id);

-- ============================================================================
-- PART 3: CREATE FORM FIELD VALUES TABLE
-- ============================================================================
-- Stores actual values entered by users when creating expenses
CREATE TABLE IF NOT EXISTS public.expense_form_field_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  expense_id UUID REFERENCES public.expenses(id) ON DELETE CASCADE NOT NULL,
  template_id UUID REFERENCES public.expense_form_field_templates(id) ON DELETE CASCADE NOT NULL,
  field_value TEXT NOT NULL, -- Store as text, parse based on field_type
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(expense_id, template_id) -- One value per field per expense
);

-- Add comment
COMMENT ON TABLE public.expense_form_field_values IS 'Stores form field values entered by users when creating expenses';

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_form_field_values_expense ON public.expense_form_field_values(expense_id);
CREATE INDEX IF NOT EXISTS idx_form_field_values_template ON public.expense_form_field_values(template_id);
CREATE INDEX IF NOT EXISTS idx_form_field_values_org ON public.expense_form_field_values(organization_id);

-- ============================================================================
-- PART 4: ENABLE RLS
-- ============================================================================
ALTER TABLE public.expense_form_field_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_category_form_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_form_field_values ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PART 5: CREATE RLS POLICIES
-- ============================================================================

-- Form Field Templates Policies
-- Admins can manage templates in their organization
CREATE POLICY "Admins can view form field templates in their organization"
  ON public.expense_form_field_templates FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

CREATE POLICY "Admins can create form field templates in their organization"
  ON public.expense_form_field_templates FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update form field templates in their organization"
  ON public.expense_form_field_templates FOR UPDATE
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete form field templates in their organization"
  ON public.expense_form_field_templates FOR DELETE
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

-- Category-Form Field Assignments Policies
-- Admins can manage assignments in their organization
CREATE POLICY "Admins can view category form field assignments in their organization"
  ON public.expense_category_form_fields FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

CREATE POLICY "Admins can create category form field assignments in their organization"
  ON public.expense_category_form_fields FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update category form field assignments in their organization"
  ON public.expense_category_form_fields FOR UPDATE
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete category form field assignments in their organization"
  ON public.expense_category_form_fields FOR DELETE
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
  );

-- Form Field Values Policies
-- Users can view values for expenses they can access
CREATE POLICY "Users can view form field values for their expenses"
  ON public.expense_form_field_values FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true
    )
    AND (
      expense_id IN (
        SELECT id FROM public.expenses 
        WHERE user_id = auth.uid()
        OR assigned_engineer_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() 
            AND organization_id = expenses.organization_id
            AND role = 'admin' 
            AND is_active = true
        )
      )
    )
  );

CREATE POLICY "Users can create form field values for their expenses"
  ON public.expense_form_field_values FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id 
      FROM public.organization_memberships 
      WHERE user_id = auth.uid() AND is_active = true
    )
    AND expense_id IN (
      SELECT id FROM public.expenses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update form field values for their expenses"
  ON public.expense_form_field_values FOR UPDATE
  USING (
    expense_id IN (
      SELECT id FROM public.expenses 
      WHERE user_id = auth.uid() 
        AND status IN ('draft', 'submitted', 'rejected')
    )
  );

-- ============================================================================
-- PART 6: CREATE UPDATE TRIGGER FOR UPDATED_AT
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_form_field_templates_updated_at
  BEFORE UPDATE ON public.expense_form_field_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_form_field_values_updated_at
  BEFORE UPDATE ON public.expense_form_field_values
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

