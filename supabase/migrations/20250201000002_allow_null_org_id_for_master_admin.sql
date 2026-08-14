-- ============================================================================
-- ALLOW NULL ORGANIZATION_ID FOR MASTER ADMINS
-- ============================================================================
-- Master admins don't belong to any organization, so organization_id should be nullable
-- This migration makes organization_id nullable and updates RLS policies
-- ============================================================================

-- Make organization_id nullable (master admins don't have an organization)
-- Only drop NOT NULL if it exists (safe to run multiple times)
DO $$
BEGIN
  -- Check if column has NOT NULL constraint
  IF EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'profiles' 
      AND column_name = 'organization_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.profiles
    ALTER COLUMN organization_id DROP NOT NULL;
  END IF;
END $$;

-- Update RLS policies to allow master admins with NULL organization_id

-- Update SELECT policy for profiles
DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  USING (
    auth.uid() IS NOT NULL 
    AND (
      organization_id = get_user_organization_id()
      OR is_master_admin()
      OR (organization_id IS NULL AND is_master_admin())
    )
  );

-- Update UPDATE policy for profiles
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (
    auth.uid() = user_id 
    AND (
      organization_id = get_user_organization_id()
      OR is_master_admin()
    )
  )
  WITH CHECK (
    auth.uid() = user_id 
    AND (
      organization_id = get_user_organization_id()
      OR is_master_admin()
    )
  );

-- Update INSERT policy for profiles (admins and master admins)
DROP POLICY IF EXISTS "Admins can insert profiles" ON public.profiles;
CREATE POLICY "Admins can insert profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (
    is_master_admin()
    OR (
      organization_id = get_user_organization_id() 
      AND has_org_role('admin')
    )
  );

-- Update get_user_organization_id function to handle master admins
CREATE OR REPLACE FUNCTION get_user_organization_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  org_id UUID;
  is_master BOOLEAN;
BEGIN
  -- Check if user is master admin first
  SELECT is_master_admin INTO is_master
  FROM public.profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
  
  -- Master admins don't have an organization
  IF is_master = true THEN
    RETURN NULL;
  END IF;
  
  -- Get organization_id from organization_memberships
  SELECT organization_id INTO org_id
  FROM public.organization_memberships
  WHERE user_id = auth.uid()
    AND is_active = true
  LIMIT 1;
  
  RETURN org_id;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_user_organization_id TO authenticated;

