-- ============================================================================
-- PART 4: SAAS MULTI-TENANCY MIGRATION
-- ============================================================================
-- This file converts the single-tenant application to multi-tenant SaaS
-- Run this AFTER 01_cleanup.sql, 02_schema.sql, and 03_policies.sql
-- WARNING: This migration adds organization_id to all tables and migrates existing data

-- ============================================================================
-- PART 1: CREATE NEW TABLES
-- ============================================================================

-- Organizations/Tenants table
CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'starter',
  subscription_status TEXT DEFAULT 'active',
  trial_ends_at TIMESTAMPTZ,
  max_users INTEGER DEFAULT 50,
  max_storage_mb INTEGER DEFAULT 5000,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}'
);

-- Organization memberships (users belong to one organization)
CREATE TABLE IF NOT EXISTS public.organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  invited_by UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true,
  UNIQUE (organization_id, user_id),
  UNIQUE (user_id) -- One organization per user
);

-- Organization settings (per-organization configuration)
CREATE TABLE IF NOT EXISTS public.organization_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL UNIQUE,
  engineer_approval_limit DECIMAL(10,2) DEFAULT 50000,
  attachment_required_above_amount DECIMAL(10,2) DEFAULT 50,
  currency TEXT DEFAULT 'INR',
  timezone TEXT DEFAULT 'Asia/Kolkata',
  custom_settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- PART 2: ADD ORGANIZATION_ID COLUMNS
-- ============================================================================

-- Add organization_id to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to expenses
ALTER TABLE public.expenses 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to expense_line_items (via expense_id relationship, but add for direct queries)
ALTER TABLE public.expense_line_items 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to attachments
ALTER TABLE public.attachments 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to audit_logs
ALTER TABLE public.audit_logs 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to expense_categories
ALTER TABLE public.expense_categories 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to locations
ALTER TABLE public.locations 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to engineer_locations (via location_id relationship)
ALTER TABLE public.engineer_locations 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to money_assignments
ALTER TABLE public.money_assignments 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to money_return_requests
ALTER TABLE public.money_return_requests 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to notifications
ALTER TABLE public.notifications 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Add organization_id to settings (keep for global settings, org-specific in organization_settings)
ALTER TABLE public.settings 
ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE;

-- ============================================================================
-- PART 3: CREATE DEFAULT ORGANIZATION AND MIGRATE EXISTING DATA
-- ============================================================================

DO $$
DECLARE
  default_org_id UUID;
BEGIN
  -- Create default organization for existing data
  INSERT INTO public.organizations (name, slug, plan, subscription_status)
  VALUES ('Default Organization', 'default', 'pro', 'active')
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO default_org_id;

  -- Get the default org if it already exists
  IF default_org_id IS NULL THEN
    SELECT id INTO default_org_id FROM public.organizations WHERE slug = 'default' LIMIT 1;
  END IF;

  -- Migrate existing profiles to default organization
  UPDATE public.profiles 
  SET organization_id = default_org_id 
  WHERE organization_id IS NULL;

  -- Migrate existing expenses to default organization
  UPDATE public.expenses 
  SET organization_id = (
    SELECT organization_id FROM public.profiles WHERE user_id = expenses.user_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate expense_line_items
  UPDATE public.expense_line_items 
  SET organization_id = (
    SELECT organization_id FROM public.expenses WHERE id = expense_line_items.expense_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate attachments
  UPDATE public.attachments 
  SET organization_id = (
    SELECT organization_id FROM public.expenses WHERE id = attachments.expense_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate audit_logs
  UPDATE public.audit_logs 
  SET organization_id = (
    SELECT organization_id FROM public.expenses WHERE id = audit_logs.expense_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate expense_categories to default organization
  UPDATE public.expense_categories 
  SET organization_id = default_org_id 
  WHERE organization_id IS NULL;

  -- Migrate locations
  UPDATE public.locations 
  SET organization_id = default_org_id 
  WHERE organization_id IS NULL;

  -- Migrate engineer_locations
  UPDATE public.engineer_locations 
  SET organization_id = (
    SELECT organization_id FROM public.locations WHERE id = engineer_locations.location_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate money_assignments
  UPDATE public.money_assignments 
  SET organization_id = (
    SELECT organization_id FROM public.profiles WHERE user_id = money_assignments.cashier_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate money_return_requests
  UPDATE public.money_return_requests 
  SET organization_id = (
    SELECT organization_id FROM public.profiles WHERE user_id = money_return_requests.requester_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate notifications
  UPDATE public.notifications 
  SET organization_id = (
    SELECT organization_id FROM public.profiles WHERE user_id = notifications.user_id LIMIT 1
  )
  WHERE organization_id IS NULL;

  -- Migrate settings to default organization
  UPDATE public.settings 
  SET organization_id = default_org_id 
  WHERE organization_id IS NULL;

  -- Create organization memberships for all existing users
  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
  SELECT 
    default_org_id,
    p.user_id,
    COALESCE((SELECT role FROM public.user_roles WHERE user_id = p.user_id LIMIT 1), 'employee'::app_role),
    true
  FROM public.profiles p
  WHERE NOT EXISTS (
    SELECT 1 FROM public.organization_memberships WHERE user_id = p.user_id
  );

  -- Create default organization settings
  INSERT INTO public.organization_settings (organization_id, engineer_approval_limit, attachment_required_above_amount)
  VALUES (default_org_id, 50000, 50)
  ON CONFLICT (organization_id) DO NOTHING;

  RAISE NOTICE 'Migration completed. Default organization ID: %', default_org_id;
END $$;

-- ============================================================================
-- PART 4: ADD NOT NULL CONSTRAINTS
-- ============================================================================

-- Make organization_id required (after data migration)
ALTER TABLE public.profiles 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.expenses 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.expense_line_items 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.attachments 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.audit_logs 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.expense_categories 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.locations 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.engineer_locations 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.money_assignments 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.money_return_requests 
ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE public.notifications 
ALTER COLUMN organization_id SET NOT NULL;

-- ============================================================================
-- PART 5: UPDATE UNIQUE CONSTRAINTS
-- ============================================================================

-- Update locations to be unique per organization
ALTER TABLE public.locations 
DROP CONSTRAINT IF EXISTS locations_name_key;

ALTER TABLE public.locations 
ADD CONSTRAINT locations_name_org_unique UNIQUE (name, organization_id);

-- Update expense_categories to be unique per organization
ALTER TABLE public.expense_categories 
DROP CONSTRAINT IF EXISTS expense_categories_name_key;

ALTER TABLE public.expense_categories 
ADD CONSTRAINT expense_categories_name_org_unique UNIQUE (name, organization_id);

-- Update transaction_number to be unique per organization
ALTER TABLE public.expenses 
DROP CONSTRAINT IF EXISTS expenses_transaction_number_key;

ALTER TABLE public.expenses 
ADD CONSTRAINT expenses_transaction_number_org_unique UNIQUE (transaction_number, organization_id);

-- ============================================================================
-- PART 6: CREATE INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_profiles_organization_id ON public.profiles(organization_id);
CREATE INDEX IF NOT EXISTS idx_expenses_organization_id ON public.expenses(organization_id);
CREATE INDEX IF NOT EXISTS idx_expense_line_items_organization_id ON public.expense_line_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_attachments_organization_id ON public.attachments(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_organization_id ON public.audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_expense_categories_organization_id ON public.expense_categories(organization_id);
CREATE INDEX IF NOT EXISTS idx_locations_organization_id ON public.locations(organization_id);
CREATE INDEX IF NOT EXISTS idx_engineer_locations_organization_id ON public.engineer_locations(organization_id);
CREATE INDEX IF NOT EXISTS idx_money_assignments_organization_id ON public.money_assignments(organization_id);
CREATE INDEX IF NOT EXISTS idx_money_return_requests_organization_id ON public.money_return_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_notifications_organization_id ON public.notifications(organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_memberships_organization_id ON public.organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_memberships_user_id ON public.organization_memberships(user_id);

-- ============================================================================
-- PART 7: CREATE HELPER FUNCTIONS
-- ============================================================================

-- Function to get user's organization_id
CREATE OR REPLACE FUNCTION get_user_organization_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org_id UUID;
BEGIN
  -- Get organization_id from JWT claim (set by application)
  -- Fallback: get from organization_memberships
  SELECT organization_id INTO org_id
  FROM public.organization_memberships
  WHERE user_id = auth.uid()
    AND is_active = true
  LIMIT 1;
  
  RETURN org_id;
END;
$$;

-- Function to check if user belongs to organization
CREATE OR REPLACE FUNCTION user_belongs_to_organization(org_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.organization_memberships
    WHERE user_id = auth.uid()
      AND organization_id = org_id
      AND is_active = true
  );
END;
$$;

-- Function to get user's role in their organization
CREATE OR REPLACE FUNCTION get_user_org_role()
RETURNS app_role
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_role app_role;
BEGIN
  SELECT role INTO user_role
  FROM public.organization_memberships
  WHERE user_id = auth.uid()
    AND is_active = true
  LIMIT 1;
  
  RETURN user_role;
END;
$$;

-- Function to check if user has role in their organization
CREATE OR REPLACE FUNCTION has_org_role(_role app_role)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.organization_memberships
    WHERE user_id = auth.uid()
      AND role = _role
      AND is_active = true
  );
END;
$$;

-- ============================================================================
-- PART 8: ENABLE RLS ON NEW TABLES
-- ============================================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PART 9: RLS POLICIES FOR NEW TABLES
-- ============================================================================

-- Organizations policies
CREATE POLICY "Users can view their own organization"
  ON public.organizations FOR SELECT
  USING (id = get_user_organization_id());

CREATE POLICY "Users can update their own organization"
  ON public.organizations FOR UPDATE
  USING (id = get_user_organization_id() AND has_org_role('admin'));

-- Organization memberships policies
CREATE POLICY "Users can view memberships in their organization"
  ON public.organization_memberships FOR SELECT
  USING (organization_id = get_user_organization_id());

CREATE POLICY "Admins can manage memberships in their organization"
  ON public.organization_memberships FOR ALL
  USING (organization_id = get_user_organization_id() AND has_org_role('admin'))
  WITH CHECK (organization_id = get_user_organization_id() AND has_org_role('admin'));

-- Organization settings policies
CREATE POLICY "Users can view settings in their organization"
  ON public.organization_settings FOR SELECT
  USING (organization_id = get_user_organization_id());

CREATE POLICY "Admins can update settings in their organization"
  ON public.organization_settings FOR UPDATE
  USING (organization_id = get_user_organization_id() AND has_org_role('admin'))
  WITH CHECK (organization_id = get_user_organization_id() AND has_org_role('admin'));

CREATE POLICY "Admins can insert settings in their organization"
  ON public.organization_settings FOR INSERT
  WITH CHECK (organization_id = get_user_organization_id() AND has_org_role('admin'));

-- ============================================================================
-- PART 10: UPDATE EXISTING RLS POLICIES TO INCLUDE ORGANIZATION CHECK
-- ============================================================================

-- This will be done in a separate update file to avoid conflicts
-- All existing policies need to add: AND organization_id = get_user_organization_id()

-- ============================================================================
-- PART 11: GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION get_user_organization_id TO authenticated;
GRANT EXECUTE ON FUNCTION user_belongs_to_organization TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_org_role TO authenticated;
GRANT EXECUTE ON FUNCTION has_org_role TO authenticated;

-- ============================================================================
-- PART 12: COMMENTS
-- ============================================================================

COMMENT ON TABLE public.organizations IS 'Multi-tenant organizations/tenants. Each organization has isolated data.';
COMMENT ON TABLE public.organization_memberships IS 'Links users to organizations. Each user belongs to exactly one organization.';
COMMENT ON TABLE public.organization_settings IS 'Per-organization configuration settings.';
COMMENT ON FUNCTION get_user_organization_id IS 'Returns the organization_id for the current authenticated user.';
COMMENT ON FUNCTION user_belongs_to_organization IS 'Checks if the current user belongs to the specified organization.';
COMMENT ON FUNCTION get_user_org_role IS 'Returns the role of the current user in their organization.';
COMMENT ON FUNCTION has_org_role IS 'Checks if the current user has the specified role in their organization.';

