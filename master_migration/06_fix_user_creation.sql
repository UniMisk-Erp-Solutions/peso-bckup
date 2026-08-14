-- ============================================================================
-- FIX USER CREATION - Handle organization_id in profile creation
-- ============================================================================
-- This fixes the handle_new_user() function to work with multi-tenancy
-- Run this AFTER 04_saas_multi_tenancy.sql and 05_update_rls_for_organizations.sql

-- ============================================================================
-- PART 1: UPDATE handle_new_user() FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  default_org_id UUID;
  user_org_id UUID;
BEGIN
  -- Try to get organization_id from user metadata (if set during user creation)
  -- This allows setting organization_id when creating users via Admin API
  IF NEW.raw_user_meta_data IS NOT NULL AND NEW.raw_user_meta_data->>'organization_id' IS NOT NULL THEN
    user_org_id := (NEW.raw_user_meta_data->>'organization_id')::UUID;
  END IF;

  -- If no organization_id in metadata, try to get default organization
  IF user_org_id IS NULL THEN
    SELECT id INTO default_org_id
    FROM public.organizations
    WHERE slug = 'default'
    LIMIT 1;
    
    IF default_org_id IS NOT NULL THEN
      user_org_id := default_org_id;
    END IF;
  END IF;

  -- Only create profile if we have an organization_id
  -- If no organization found, skip profile creation (will be handled manually)
  IF user_org_id IS NOT NULL THEN
    INSERT INTO public.profiles (user_id, name, email, organization_id)
    VALUES (
      NEW.id,
      COALESCE(NEW.raw_user_meta_data->>'name', 'New User'),
      NEW.email,
      user_org_id
    )
    ON CONFLICT (user_id) DO NOTHING; -- Don't error if profile already exists
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- PART 2: CREATE FUNCTION TO ASSIGN USER TO ORGANIZATION
-- ============================================================================
-- This function can be called after user creation to assign them to an organization

CREATE OR REPLACE FUNCTION public.assign_user_to_organization(
  p_user_id UUID,
  p_organization_id UUID,
  p_role app_role DEFAULT 'employee'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Create or update profile with organization_id
  INSERT INTO public.profiles (user_id, name, email, organization_id, is_active)
  SELECT 
    p_user_id,
    COALESCE((SELECT raw_user_meta_data->>'name' FROM auth.users WHERE id = p_user_id), 'New User'),
    (SELECT email FROM auth.users WHERE id = p_user_id),
    p_organization_id,
    true
  ON CONFLICT (user_id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    is_active = true;

  -- Create organization membership
  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)
  VALUES (p_organization_id, p_user_id, p_role, true)
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    role = EXCLUDED.role,
    is_active = true;
END;
$$;

-- ============================================================================
-- PART 3: GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.assign_user_to_organization TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_user_to_organization TO service_role;

-- ============================================================================
-- PART 4: UPDATE RLS POLICY TO ALLOW PROFILE CREATION VIA TRIGGER
-- ============================================================================
-- The trigger runs as SECURITY DEFINER, so it bypasses RLS, but we need to ensure
-- the function can insert profiles. Since it's SECURITY DEFINER, it should work.
-- However, let's add a policy that allows the function to insert profiles.

-- Note: SECURITY DEFINER functions bypass RLS, so the trigger should work.
-- But we'll add a comment to document this.

COMMENT ON FUNCTION public.handle_new_user() IS 
'Automatically creates a profile when a new auth user is created. 
Assigns user to default organization if organization_id not provided in metadata.
If no default organization exists, profile creation is skipped and must be done manually.';

COMMENT ON FUNCTION public.assign_user_to_organization IS 
'Assigns an existing user to an organization. Creates profile and organization membership.
Use this function after creating a user in Supabase Auth to assign them to an organization.';

