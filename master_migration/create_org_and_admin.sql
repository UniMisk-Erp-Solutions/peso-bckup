-- ============================================================================
-- CREATE ORGANIZATION AND ADMIN ACCOUNT - COMPLETE SETUP
-- ============================================================================
-- This script creates a new organization and admin account in one go
-- 
-- USAGE: Set the variables below and run this entire script
-- 
-- NOTE: This requires Supabase service role or admin access to create auth users
-- If you don't have service role access, you'll need to create the auth user
-- manually in Supabase Dashboard first, then run the second part of this script

-- ============================================================================
-- STEP 1: SET YOUR VARIABLES HERE
-- ============================================================================

DO $$
DECLARE
  -- ========== SET THESE VALUES ==========
  org_name TEXT := 'Patidar Travels';
  org_slug TEXT := 'patidar-travels';  -- URL-friendly, lowercase, no spaces
  admin_email TEXT := 'admin@patidartravels.com';
  admin_password TEXT := 'qwertyui';  -- Will be used if creating via Admin API
  admin_name TEXT := 'Admin User';
  -- =======================================
  
  -- Internal variables
  new_org_id UUID;
  auth_user_id UUID;
  existing_user_id UUID;
BEGIN
  -- ============================================================================
  -- STEP 2: CREATE ORGANIZATION
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

  RAISE NOTICE '✓ Created organization: % (ID: %)', org_name, new_org_id;

  -- ============================================================================
  -- STEP 3: CREATE ORGANIZATION SETTINGS
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
    50000,
    50,
    'INR',
    'Asia/Kolkata'
  )
  ON CONFLICT (organization_id) DO UPDATE SET
    updated_at = now();

  RAISE NOTICE '✓ Created organization settings';

  -- ============================================================================
  -- STEP 4: CHECK IF AUTH USER ALREADY EXISTS
  -- ============================================================================
  
  SELECT id INTO existing_user_id
  FROM auth.users
  WHERE email = admin_email
  LIMIT 1;

  IF existing_user_id IS NOT NULL THEN
    RAISE NOTICE '✓ Found existing auth user: %', admin_email;
    auth_user_id := existing_user_id;
  ELSE
    -- ============================================================================
    -- STEP 5: CREATE AUTH USER (Requires service role or admin API)
    -- ============================================================================
    -- Note: Direct insertion into auth.users is not allowed via SQL
    -- You need to use Supabase Admin API or create user manually in Dashboard
    
    RAISE NOTICE '';
    RAISE NOTICE '⚠️  AUTH USER CREATION REQUIRED';
    RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    RAISE NOTICE 'The auth user does not exist. You have two options:';
    RAISE NOTICE '';
    RAISE NOTICE 'OPTION 1: Create user manually in Supabase Dashboard';
    RAISE NOTICE '  1. Go to Authentication > Users > Add User';
    RAISE NOTICE '  2. Email: %', admin_email;
    RAISE NOTICE '  3. Password: %', admin_password;
    RAISE NOTICE '  4. Then run the "COMPLETE SETUP" query below';
    RAISE NOTICE '';
    RAISE NOTICE 'OPTION 2: Use Supabase Admin API (if you have service role key)';
    RAISE NOTICE '  Run this in your application or via curl:';
    RAISE NOTICE '  POST https://YOUR_PROJECT.supabase.co/auth/v1/admin/users';
    RAISE NOTICE '  Headers: {';
    RAISE NOTICE '    "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY",';
    RAISE NOTICE '    "Content-Type": "application/json"';
    RAISE NOTICE '  }';
    RAISE NOTICE '  Body: {';
    RAISE NOTICE '    "email": "%",', admin_email;
    RAISE NOTICE '    "password": "%",', admin_password;
    RAISE NOTICE '    "email_confirm": true';
    RAISE NOTICE '  }';
    RAISE NOTICE '';
    RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
    RAISE NOTICE '';
    RAISE NOTICE 'After creating the auth user, run this query to complete setup:';
    RAISE NOTICE '';
    RAISE NOTICE 'DO $$';
    RAISE NOTICE 'DECLARE';
    RAISE NOTICE '  auth_user_id UUID;';
    RAISE NOTICE '  org_id UUID := ''%'';', new_org_id;
    RAISE NOTICE 'BEGIN';
    RAISE NOTICE '  SELECT id INTO auth_user_id FROM auth.users WHERE email = ''%'';', admin_email;
    RAISE NOTICE '  IF auth_user_id IS NULL THEN';
    RAISE NOTICE '    RAISE EXCEPTION ''User % not found. Please create the user first.'';', admin_email;
    RAISE NOTICE '  END IF;';
    RAISE NOTICE '';
    RAISE NOTICE '  INSERT INTO public.profiles (user_id, name, email, organization_id)';
    RAISE NOTICE '  VALUES (auth_user_id, ''%'', ''%'', org_id)', admin_name, admin_email;
    RAISE NOTICE '  ON CONFLICT (user_id) DO UPDATE SET';
    RAISE NOTICE '    name = EXCLUDED.name,';
    RAISE NOTICE '    email = EXCLUDED.email,';
    RAISE NOTICE '    organization_id = EXCLUDED.organization_id;';
    RAISE NOTICE '';
    RAISE NOTICE '  INSERT INTO public.organization_memberships (organization_id, user_id, role, is_active)';
    RAISE NOTICE '  VALUES (org_id, auth_user_id, ''admin'', true)';
    RAISE NOTICE '  ON CONFLICT (organization_id, user_id) DO UPDATE SET';
    RAISE NOTICE '    role = ''admin'',';
    RAISE NOTICE '    is_active = true;';
    RAISE NOTICE '';
    RAISE NOTICE '  RAISE NOTICE ''✓ Admin account setup complete for: %'';', admin_email;
    RAISE NOTICE 'END $$;';
    RAISE NOTICE '';
    
    -- Exit early since we can't create auth user via SQL
    RETURN;
  END IF;

  -- ============================================================================
  -- STEP 6: CREATE PROFILE
  -- ============================================================================
  
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

  RAISE NOTICE '✓ Created/updated profile';

  -- ============================================================================
  -- STEP 7: CREATE ORGANIZATION MEMBERSHIP
  -- ============================================================================
  
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
  )
  ON CONFLICT (organization_id, user_id) DO UPDATE SET
    role = 'admin',
    is_active = true;

  RAISE NOTICE '✓ Created organization membership with admin role';

  -- ============================================================================
  -- STEP 8: SUCCESS MESSAGE
  -- ============================================================================
  
  RAISE NOTICE '';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  RAISE NOTICE '✓ SETUP COMPLETE!';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  RAISE NOTICE '';
  RAISE NOTICE 'Organization Details:';
  RAISE NOTICE '  Name: %', org_name;
  RAISE NOTICE '  Slug: %', org_slug;
  RAISE NOTICE '  ID: %', new_org_id;
  RAISE NOTICE '';
  RAISE NOTICE 'Admin Account:';
  RAISE NOTICE '  Email: %', admin_email;
  RAISE NOTICE '  Name: %', admin_name;
  RAISE NOTICE '  User ID: %', auth_user_id;
  RAISE NOTICE '';
  RAISE NOTICE 'The admin can now log in and start using the system!';
  RAISE NOTICE '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

END $$;

