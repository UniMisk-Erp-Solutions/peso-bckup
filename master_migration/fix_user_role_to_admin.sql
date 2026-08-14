-- ============================================================================
-- FIX USER ROLE TO ADMIN
-- ============================================================================
-- Run this query to change a user's role to admin in their organization
-- Replace the email address below with the user's email

DO $$
DECLARE
  -- ========== SET THE USER EMAIL HERE ==========
  user_email TEXT := 'admin@patidartravels.com';
  -- =============================================
  
  auth_user_id UUID;
  org_id UUID;
BEGIN
  -- Get user ID
  SELECT id INTO auth_user_id
  FROM auth.users
  WHERE email = user_email
  LIMIT 1;

  IF auth_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found', user_email;
  END IF;

  -- Get user's organization_id
  SELECT organization_id INTO org_id
  FROM public.profiles
  WHERE user_id = auth_user_id
  LIMIT 1;

  IF org_id IS NULL THEN
    RAISE EXCEPTION 'User % is not assigned to any organization', user_email;
  END IF;

  -- Update organization membership to admin role
  UPDATE public.organization_memberships
  SET role = 'admin',
      is_active = true
  WHERE user_id = auth_user_id
    AND organization_id = org_id;

  -- Check if membership was updated
  IF NOT FOUND THEN
    -- If no membership exists, create it
    INSERT INTO public.organization_memberships (
      organization_id,
      user_id,
      role,
      is_active
    )
    VALUES (
      org_id,
      auth_user_id,
      'admin',
      true
    );
    RAISE NOTICE '✓ Created admin membership for user: %', user_email;
  ELSE
    RAISE NOTICE '✓ Updated user role to admin: %', user_email;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  RAISE NOTICE 'SUCCESS!';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  RAISE NOTICE 'User: %', user_email;
  RAISE NOTICE 'User ID: %', auth_user_id;
  RAISE NOTICE 'Organization ID: %', org_id;
  RAISE NOTICE 'Role: admin';
  RAISE NOTICE '';
  RAISE NOTICE 'The user can now log in with admin privileges!';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

END $$;

