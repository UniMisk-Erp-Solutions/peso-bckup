-- ============================================================================
-- CREATE NEW ORGANIZATION WITH ADMIN ACCOUNT
-- ============================================================================
-- This script creates a new organization and admin account
-- Usage: Replace the variables at the top with actual values

DO $$
DECLARE
  -- SET THESE VARIABLES
  org_name TEXT := 'Patidar Travels';
  org_slug TEXT := 'Patidar-Travels';
  admin_email TEXT := 'admin@patidartravels.com';
  admin_password TEXT := 'qwertyui'; -- Generate a secure password
  admin_name TEXT := 'Admin User';
  created_by_user_id UUID := NULL; -- Set to super admin user_id if you have one, or NULL
  
  -- Internal variables
  new_org_id UUID;
  new_user_id UUID;
  admin_profile_id UUID;
BEGIN
  -- Step 1: Create organization
  INSERT INTO public.organizations (
    name, 
    slug, 
    plan, 
    subscription_status,
    created_by
  )
  VALUES (
    org_name,
    org_slug,
    'starter',
    'active',
    created_by_user_id
  )
  RETURNING id INTO new_org_id;

  RAISE NOTICE 'Created organization: % (ID: %)', org_name, new_org_id;

  -- Step 2: Create user in Supabase Auth
  -- Note: This requires Supabase Admin API or service role
  -- For now, we'll create the profile and membership, but you'll need to create the auth user separately
  -- OR use Supabase Admin API to create the user
  
  -- Step 3: Create organization settings
  INSERT INTO public.organization_settings (
    organization_id,
    engineer_approval_limit,
    attachment_required_above_amount
  )
  VALUES (
    new_org_id,
    50000,
    50
  );

  RAISE NOTICE 'Created organization settings for: %', org_name;

  -- Step 4: Instructions for creating auth user
  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'NEXT STEPS:';
  RAISE NOTICE '========================================';
  RAISE NOTICE '1. Create user in Supabase Auth Dashboard:';
  RAISE NOTICE '   - Email: %', admin_email;
  RAISE NOTICE '   - Password: %', admin_password;
  RAISE NOTICE '';
  RAISE NOTICE '2. After creating the auth user, run this query:';
  RAISE NOTICE '';
  RAISE NOTICE '   DO $$';
  RAISE NOTICE '   DECLARE';
  RAISE NOTICE '     auth_user_id UUID;';
  RAISE NOTICE '     org_id UUID := ''%'';', new_org_id;
  RAISE NOTICE '   BEGIN';
  RAISE NOTICE '     -- Get the user_id from auth.users';
  RAISE NOTICE '     SELECT id INTO auth_user_id';
  RAISE NOTICE '     FROM auth.users';
  RAISE NOTICE '     WHERE email = ''%'';', admin_email;
  RAISE NOTICE '';
  RAISE NOTICE '     -- Create profile';
  RAISE NOTICE '     INSERT INTO public.profiles (user_id, name, email, organization_id)';
  RAISE NOTICE '     VALUES (auth_user_id, ''%'', ''%'', org_id);', admin_name, admin_email;
  RAISE NOTICE '';
  RAISE NOTICE '     -- Create organization membership';
  RAISE NOTICE '     INSERT INTO public.organization_memberships (organization_id, user_id, role)';
  RAISE NOTICE '     VALUES (org_id, auth_user_id, ''admin'');';
  RAISE NOTICE '';
  RAISE NOTICE '     RAISE NOTICE ''Admin account setup complete for: %'';', admin_email;
  RAISE NOTICE '   END $$;';
  RAISE NOTICE '';
  RAISE NOTICE '3. Provide these credentials to the organization:';
  RAISE NOTICE '   - Organization: %', org_name;
  RAISE NOTICE '   - Organization Slug: %', org_slug;
  RAISE NOTICE '   - Admin Email: %', admin_email;
  RAISE NOTICE '   - Admin Password: %', admin_password;
  RAISE NOTICE '========================================';

END $$;

