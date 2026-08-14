-- ============================================================================
-- MASTER ADMIN SYSTEM MIGRATION
-- ============================================================================
-- This migration creates the complete master admin system including:
-- - Master admin user management
-- - Organization payment/subscription tracking
-- - Simplified subscription plans (free-trial, pro)
-- - Master admin announcements with expiry
-- - Storage monitoring functions
-- - Last activity tracking for organizations
-- ============================================================================

-- ============================================================================
-- PART 1: MASTER ADMIN USER MANAGEMENT
-- ============================================================================

-- Add master_admin flag to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS is_master_admin BOOLEAN DEFAULT false;

-- Create master_admin_memberships table (alternative approach)
CREATE TABLE IF NOT EXISTS public.master_admin_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_is_master_admin ON public.profiles(is_master_admin) WHERE is_master_admin = true;
CREATE INDEX IF NOT EXISTS idx_master_admin_memberships_user_id ON public.master_admin_memberships(user_id) WHERE is_active = true;

-- ============================================================================
-- PART 2: ORGANIZATION PAYMENT/SUBSCRIPTION FIELDS
-- ============================================================================

-- Add payment/subscription fields to organizations
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('active', 'pending', 'overdue', 'suspended', 'cancelled')),
ADD COLUMN IF NOT EXISTS payment_due_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_payment_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS billing_email TEXT,
ADD COLUMN IF NOT EXISTS billing_address JSONB,
ADD COLUMN IF NOT EXISTS subscription_start_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS subscription_end_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_organizations_payment_status ON public.organizations(payment_status);
CREATE INDEX IF NOT EXISTS idx_organizations_is_blocked ON public.organizations(is_blocked) WHERE is_blocked = true;
CREATE INDEX IF NOT EXISTS idx_organizations_last_activity ON public.organizations(last_activity_at DESC);

-- ============================================================================
-- PART 3: SIMPLIFIED SUBSCRIPTION PLANS
-- ============================================================================

-- Create subscription plans table (simplified - just free-trial and pro)
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default plans (free-trial and pro)
INSERT INTO public.subscription_plans (name, slug, description, is_active)
VALUES
  ('Free Trial', 'free-trial', 'Free trial plan for new organizations', true),
  ('Pro Plan', 'pro', 'Professional plan with full features', true)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================================
-- PART 4: ORGANIZATION PAYMENTS TABLE
-- ============================================================================

-- Create organization payments/subscriptions table
CREATE TABLE IF NOT EXISTS public.organization_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE NOT NULL,
  plan_id UUID REFERENCES public.subscription_plans(id),
  amount DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'INR',
  payment_status TEXT NOT NULL CHECK (payment_status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_method TEXT,
  transaction_id TEXT,
  payment_date TIMESTAMPTZ,
  billing_period_start TIMESTAMPTZ,
  billing_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_organization_payments_org_id ON public.organization_payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_payments_status ON public.organization_payments(payment_status);

-- ============================================================================
-- PART 5: MASTER ADMIN ANNOUNCEMENTS WITH EXPIRY
-- ============================================================================

-- Create master_admin_announcements table
CREATE TABLE IF NOT EXISTS public.master_admin_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE, -- NULL = all organizations
  message TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('payment_reminder', 'warning', 'info', 'urgent')),
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_announcements_org_id ON public.master_admin_announcements(organization_id);
CREATE INDEX IF NOT EXISTS idx_announcements_expires_at ON public.master_admin_announcements(expires_at);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON public.master_admin_announcements(is_active, expires_at) WHERE is_active = true;

-- ============================================================================
-- PART 6: HELPER FUNCTIONS
-- ============================================================================

-- Function to check if user is master admin
CREATE OR REPLACE FUNCTION is_master_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE user_id = auth.uid()
      AND is_master_admin = true
  ) OR EXISTS (
    SELECT 1
    FROM public.master_admin_memberships
    WHERE user_id = auth.uid()
      AND is_active = true
  );
END;
$$;

-- Function to check if organization is active (not blocked)
CREATE OR REPLACE FUNCTION is_organization_active(org_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE id = org_id
      AND is_active = true
      AND is_blocked = false
      AND (payment_status = 'active' OR payment_status IS NULL)
  );
END;
$$;

-- Function to get organization user count (master admin only, no individual user data)
CREATE OR REPLACE FUNCTION get_organization_user_count(org_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_count INTEGER;
BEGIN
  -- Only master admins can call this
  IF NOT is_master_admin() THEN
    RAISE EXCEPTION 'Only master admins can view user counts';
  END IF;

  SELECT COUNT(*) INTO user_count
  FROM public.organization_memberships
  WHERE organization_id = org_id
    AND is_active = true;

  RETURN user_count;
END;
$$;

-- Function to get storage metrics (Option A + B)
CREATE OR REPLACE FUNCTION get_storage_metrics()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  db_size_bytes BIGINT;
  storage_size_bytes BIGINT;
  total_size_bytes BIGINT;
BEGIN
  -- Only master admins can call this
  IF NOT is_master_admin() THEN
    RAISE EXCEPTION 'Only master admins can view storage metrics';
  END IF;

  -- Option A: Database size (READ-ONLY)
  SELECT pg_database_size('postgres') INTO db_size_bytes;
  
  -- Option B: Storage buckets (READ-ONLY SELECT)
  SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) INTO storage_size_bytes
  FROM storage.objects;
  
  total_size_bytes := db_size_bytes + storage_size_bytes;
  
  -- Return JSON with all metrics
  RETURN jsonb_build_object(
    'database_size_gb', ROUND(db_size_bytes / 1024.0 / 1024.0 / 1024.0, 2),
    'storage_size_gb', ROUND(storage_size_bytes / 1024.0 / 1024.0 / 1024.0, 2),
    'total_size_gb', ROUND(total_size_bytes / 1024.0 / 1024.0 / 1024.0, 2),
    'database_size_bytes', db_size_bytes,
    'storage_size_bytes', storage_size_bytes,
    'total_size_bytes', total_size_bytes
  );
END;
$$;

-- Function to update organization last activity
CREATE OR REPLACE FUNCTION update_organization_activity(org_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update last_activity_at for the organization
  -- This is called when any activity happens (expense creation, update, etc.)
  UPDATE public.organizations
  SET last_activity_at = NOW()
  WHERE id = org_id;
END;
$$;

-- Function to create organization with admin user
CREATE OR REPLACE FUNCTION create_organization_with_admin(
  org_name TEXT,
  org_slug TEXT,
  plan_slug TEXT,
  admin_email TEXT,
  admin_name TEXT,
  admin_password TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id UUID;
  new_user_id UUID;
  plan_record RECORD;
  existing_user_id UUID;
BEGIN
  -- Check if user is master admin
  IF NOT is_master_admin() THEN
    RAISE EXCEPTION 'Only master admins can create organizations';
  END IF;

  -- Validate plan
  SELECT * INTO plan_record
  FROM subscription_plans
  WHERE slug = plan_slug AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid plan: %', plan_slug;
  END IF;

  -- Check if organization slug already exists
  IF EXISTS (SELECT 1 FROM organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization slug already exists: %', org_slug;
  END IF;

  -- Create organization
  INSERT INTO organizations (
    name,
    slug,
    plan,
    subscription_status,
    payment_status,
    is_active,
    subscription_start_date
  )
  VALUES (
    org_name,
    org_slug,
    plan_slug,
    'active',
    CASE WHEN plan_slug = 'free-trial' THEN 'active' ELSE 'pending' END,
    true,
    NOW()
  )
  RETURNING id INTO new_org_id;

  -- Check if user already exists in auth.users
  SELECT id INTO existing_user_id
  FROM auth.users
  WHERE email = admin_email
  LIMIT 1;

  IF existing_user_id IS NOT NULL THEN
    -- User exists, use existing user_id
    new_user_id := existing_user_id;
  ELSE
    -- User doesn't exist - Note: This requires Supabase Admin API
    -- For now, we'll create the profile and membership, but auth user must be created separately
    -- Or use Supabase Admin API via service role
    RAISE NOTICE 'User does not exist. Please create auth user first or use Supabase Admin API.';
    -- Return org_id anyway, admin user can be linked later
    RETURN new_org_id;
  END IF;

  -- Create profile if it doesn't exist
  INSERT INTO public.profiles (user_id, name, email, organization_id)
  VALUES (new_user_id, admin_name, admin_email, new_org_id)
  ON CONFLICT (user_id) DO UPDATE SET
    organization_id = new_org_id,
    name = admin_name,
    email = admin_email;

  -- Create organization membership with admin role
  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
  VALUES (new_org_id, new_user_id, 'admin', true)
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    role = 'admin',
    is_active = true;

  -- Create organization settings
  INSERT INTO public.organization_settings (
    organization_id,
    engineer_approval_limit,
    attachment_required_above_amount
  )
  VALUES (
    new_org_id,
    50000,
    50
  )
  ON CONFLICT (organization_id) DO NOTHING;

  RETURN new_org_id;
END;
$$;

-- ============================================================================
-- PART 7: UPDATE RLS POLICIES
-- ============================================================================

-- Update organizations policies to allow master admins
DROP POLICY IF EXISTS "Users can view their own organization" ON public.organizations;
CREATE POLICY "Users can view their own organization"
  ON public.organizations FOR SELECT
  USING (
    id = get_user_organization_id() 
    OR is_master_admin()
  );

DROP POLICY IF EXISTS "Users can update their own organization" ON public.organizations;
CREATE POLICY "Users can update their own organization"
  ON public.organizations FOR UPDATE
  USING (
    (id = get_user_organization_id() AND has_org_role('admin'))
    OR is_master_admin()
  )
  WITH CHECK (
    (id = get_user_organization_id() AND has_org_role('admin'))
    OR is_master_admin()
  );

-- Master admins can insert organizations
DROP POLICY IF EXISTS "Master admins can create organizations" ON public.organizations;
CREATE POLICY "Master admins can create organizations"
  ON public.organizations FOR INSERT
  WITH CHECK (is_master_admin());

-- Master admins can delete organizations
DROP POLICY IF EXISTS "Master admins can delete organizations" ON public.organizations;
CREATE POLICY "Master admins can delete organizations"
  ON public.organizations FOR DELETE
  USING (is_master_admin());

-- RLS policies for subscription_plans
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view active plans" ON public.subscription_plans;
CREATE POLICY "Anyone can view active plans"
  ON public.subscription_plans FOR SELECT
  USING (is_active = true OR is_master_admin());

DROP POLICY IF EXISTS "Master admins can manage plans" ON public.subscription_plans;
CREATE POLICY "Master admins can manage plans"
  ON public.subscription_plans FOR ALL
  USING (is_master_admin())
  WITH CHECK (is_master_admin());

-- RLS policies for organization_payments
ALTER TABLE public.organization_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Organizations can view their payments" ON public.organization_payments;
CREATE POLICY "Organizations can view their payments"
  ON public.organization_payments FOR SELECT
  USING (
    organization_id = get_user_organization_id()
    OR is_master_admin()
  );

DROP POLICY IF EXISTS "Master admins can manage payments" ON public.organization_payments;
CREATE POLICY "Master admins can manage payments"
  ON public.organization_payments FOR ALL
  USING (is_master_admin())
  WITH CHECK (is_master_admin());

-- RLS policies for master_admin_announcements
ALTER TABLE public.master_admin_announcements ENABLE ROW LEVEL SECURITY;

-- Master admins can manage announcements
CREATE POLICY "Master admins can manage announcements"
  ON public.master_admin_announcements FOR ALL
  USING (is_master_admin())
  WITH CHECK (is_master_admin());

-- Organization admins can view announcements for their org or global ones
CREATE POLICY "Organizations can view their announcements"
  ON public.master_admin_announcements FOR SELECT
  USING (
    (organization_id = get_user_organization_id() OR organization_id IS NULL)
    AND is_active = true
    AND expires_at > NOW()
  );

-- RLS policies for master_admin_memberships
ALTER TABLE public.master_admin_memberships ENABLE ROW LEVEL SECURITY;

-- Only master admins can view/manage master admin memberships
CREATE POLICY "Master admins can manage master admin memberships"
  ON public.master_admin_memberships FOR ALL
  USING (is_master_admin())
  WITH CHECK (is_master_admin());

-- ============================================================================
-- PART 8: GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION is_master_admin TO authenticated;
GRANT EXECUTE ON FUNCTION is_organization_active TO authenticated;
GRANT EXECUTE ON FUNCTION get_organization_user_count TO authenticated;
GRANT EXECUTE ON FUNCTION get_storage_metrics TO authenticated;
GRANT EXECUTE ON FUNCTION update_organization_activity TO authenticated;
GRANT EXECUTE ON FUNCTION create_organization_with_admin TO authenticated;

-- ============================================================================
-- PART 9: CREATE MASTER ADMIN USER
-- ============================================================================

-- Note: This creates the auth user and profile
-- The actual auth user creation should be done via Supabase Admin API or manually
-- This script sets up the profile and master admin flag

DO $$
DECLARE
  master_admin_email TEXT := 'mithil20056mistry@gmail.com';
  master_admin_name TEXT := 'Master Admin';
  master_admin_user_id UUID;
BEGIN
  -- Check if user exists in auth.users
  SELECT id INTO master_admin_user_id
  FROM auth.users
  WHERE email = master_admin_email
  LIMIT 1;

  IF master_admin_user_id IS NOT NULL THEN
    -- User exists, update profile
    -- Master admins don't have an organization_id (set to NULL)
    INSERT INTO public.profiles (user_id, name, email, is_master_admin, organization_id)
    VALUES (master_admin_user_id, master_admin_name, master_admin_email, true, NULL)
    ON CONFLICT (user_id) DO UPDATE SET
      is_master_admin = true,
      name = master_admin_name,
      email = master_admin_email,
      organization_id = NULL; -- Master admins don't belong to any organization

    -- Also add to master_admin_memberships
    INSERT INTO public.master_admin_memberships (user_id, is_active)
    VALUES (master_admin_user_id, true)
    ON CONFLICT (user_id) DO UPDATE SET
      is_active = true;

    RAISE NOTICE 'Master admin profile updated for user: %', master_admin_email;
  ELSE
    RAISE NOTICE 'User does not exist in auth.users. Please create the user first with email: % and password: qwertyui', master_admin_email;
    RAISE NOTICE 'After creating the auth user, run this query to set master admin flag:';
    RAISE NOTICE 'UPDATE public.profiles SET is_master_admin = true WHERE email = ''%'';', master_admin_email;
  END IF;
END $$;

-- ============================================================================
-- PART 10: COMMENTS
-- ============================================================================

COMMENT ON TABLE public.master_admin_memberships IS 'Master admin user memberships. Users in this table have system-wide access.';
COMMENT ON COLUMN public.profiles.is_master_admin IS 'Flag indicating if user is a master admin with system-wide access.';
COMMENT ON TABLE public.subscription_plans IS 'Simplified subscription plans: free-trial and pro only.';
COMMENT ON TABLE public.organization_payments IS 'Payment history for organizations.';
COMMENT ON TABLE public.master_admin_announcements IS 'Announcements from master admin to organizations with expiry dates.';
COMMENT ON COLUMN public.organizations.last_activity_at IS 'Timestamp of last activity (non-login) in the organization.';
COMMENT ON FUNCTION is_master_admin IS 'Checks if current user is a master admin.';
COMMENT ON FUNCTION get_storage_metrics IS 'Returns storage metrics (database + file storage) for master admin.';
COMMENT ON FUNCTION get_organization_user_count IS 'Returns user count for an organization (master admin only, no individual user data).';
COMMENT ON FUNCTION update_organization_activity IS 'Updates last_activity_at timestamp for an organization.';

