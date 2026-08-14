-- ============================================================================
-- CREATE ORGANIZATION AND ADMIN ACCOUNT - ONE-STEP SETUP
-- ============================================================================
-- This script creates a new organization and admin account
-- 
-- SETUP: 
-- 1. Set the variables below (org_name, org_slug, admin_email, admin_password, admin_name)
-- 2. Run this entire script
-- 3. If auth user doesn't exist, you'll need to create it in Supabase Dashboard
--    then run the "COMPLETE SETUP" query provided in the output
--
-- NOTE: This script will create the organization and settings immediately.
--       If the auth user exists, it will complete the full setup automatically.
--       If not, it will provide a follow-up query to run after creating the user.

-- ============================================================================
-- CONFIGURATION - SET YOUR VALUES HERE
-- ============================================================================

DO $$
DECLARE
  -- ========== EDIT THESE VALUES ==========
  org_name TEXT := 'Bikes auto Hero';
  org_slug TEXT := 'bikes-auto-hero';  -- lowercase, no spaces, URL-friendly
  admin_email TEXT := 'admin@bill.com';
  admin_password TEXT := 'qwertyui';
  admin_name TEXT := 'Admin User';
  -- ========================================
  
  -- Internal variables
  new_org_id UUID;
  auth_user_id UUID;
  setup_complete BOOLEAN := false;
  completion_query TEXT;
BEGIN
  -- ============================================================================
  -- CREATE ORGANIZATION
  -- ============================================================================
  
  INSERT INTO public.organizations (
    name, 
    slug, 
    plan, 
    subscription_status
  )
  VALUES (
    org_name,
    org_slug,
    'starter',
    'active'
  )
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    updated_at = now()
  RETURNING id INTO new_org_id;

  RAISE NOTICE '✓ Organization created: % (ID: %)', org_name, new_org_id;

  -- ============================================================================
  -- CREATE ORGANIZATION SETTINGS
  -- ============================================================================
  
  INSERT INTO public.organization_settings (
    organization_id,
    engineer_approval_limit,
    attachment_required_above_amount,
    currency,
    timezone
  )
  VALUES (
    new_org_id,
    500,
    50,
    'INR',
    'Asia/Kolkata'
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    updated_at = now();

  RAISE NOTICE '✓ Organization settings created';

  -- ============================================================================
  -- CHECK IF AUTH USER EXISTS
  -- ============================================================================
  
  SELECT id INTO auth_user_id
  FROM auth.users
  WHERE email = admin_email
  LIMIT 1;

  -- ============================================================================
  -- IF USER EXISTS: COMPLETE SETUP AUTOMATICALLY
  -- ============================================================================
  
  IF auth_user_id IS NOT NULL THEN
    -- Create profile
    INSERT INTO public.profiles (
      user_id,
      name,
      email,
      organization_id,
      is_active
    )
    VALUES (
      auth_user_id,
      admin_name,
      admin_email,
      new_org_id,
      true
    )
    ON CONFLICT (user_id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      organization_id = EXCLUDED.organization_id,
      is_active = true;

    RAISE NOTICE '✓ Profile created/updated';

    -- Delete any existing organization membership for this user
    -- (since user_id has a unique constraint - one org per user)
    DELETE FROM public.organization_memberships
    WHERE user_id = auth_user_id;

    RAISE NOTICE '✓ Removed any existing organization membership';

    -- Create organization membership
    INSERT INTO public.organization_memberships (
      organization_id,
      user_id,
      role,
      is_active
    )
    VALUES (
      new_org_id,
      auth_user_id,
      'admin',
      true
    );

    RAISE NOTICE '✓ Organization membership created with admin role';
    setup_complete := true;
  END IF;

  -- ============================================================================
  -- OUTPUT RESULTS
  -- ============================================================================
  
  RAISE NOTICE '';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  
  IF setup_complete THEN
    RAISE NOTICE '✓ SETUP COMPLETE!';
    RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    RAISE NOTICE '';
    RAISE NOTICE 'Organization: %', org_name;
    RAISE NOTICE 'Organization ID: %', new_org_id;
    RAISE NOTICE 'Admin Email: %', admin_email;
    RAISE NOTICE 'Admin User ID: %', auth_user_id;
    RAISE NOTICE '';
    RAISE NOTICE 'The admin can now log in and start using the system!';
  ELSE
    RAISE NOTICE '⚠️  PARTIAL SETUP COMPLETE';
    RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    RAISE NOTICE '';
    RAISE NOTICE 'Organization created: %', org_name;
    RAISE NOTICE 'Organization ID: %', new_org_id;
    RAISE NOTICE '';
    RAISE NOTICE 'NEXT STEP: Create the auth user, then run the query below:';
    RAISE NOTICE '';
    RAISE NOTICE '1. Go to Supabase Dashboard > Authentication > Users';
    RAISE NOTICE '2. Click "Add User"';
    RAISE NOTICE '3. Enter:';
    RAISE NOTICE '   Email: %', admin_email;
    RAISE NOTICE '   Password: %', admin_password;
    RAISE NOTICE '   Auto Confirm User: Yes';
    RAISE NOTICE '4. Click "Create User"';
    RAISE NOTICE '';
    RAISE NOTICE '5. Then run this query to complete setup:';
    RAISE NOTICE '';
    RAISE NOTICE 'Organization ID: %', new_org_id;
    RAISE NOTICE 'Admin Email: %', admin_email;
    RAISE NOTICE 'Admin Name: %', admin_name;
    RAISE NOTICE '';
    RAISE NOTICE 'Run this query after creating the auth user:';
    RAISE NOTICE '';
    completion_query := format('DO $complete$ DECLARE auth_user_id UUID; org_id UUID := %L; BEGIN SELECT id INTO auth_user_id FROM auth.users WHERE email = %L LIMIT 1; IF auth_user_id IS NULL THEN RAISE EXCEPTION ''User not found''; END IF; PERFORM public.assign_user_to_organization(auth_user_id, org_id, ''admin''); RAISE NOTICE ''Setup complete! Admin can now log in.''; END $complete$;', new_org_id, admin_email);
    RAISE NOTICE '%', completion_query;
    RAISE NOTICE '';
    RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  END IF;
  
  RAISE NOTICE '';

END $$;

