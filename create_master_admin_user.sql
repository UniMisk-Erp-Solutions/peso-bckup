
-- ============================================================================
-- CREATE MASTER ADMIN USER
-- ============================================================================
-- This script creates the master admin user in Supabase Auth and sets up the profile
-- 
-- IMPORTANT: This requires Supabase Admin API access or service role key
-- If you don't have admin access, create the user manually in Supabase Dashboard
-- then run the UPDATE query at the bottom to set the master admin flag
-- ============================================================================

-- Option 1: If you have Supabase Admin API access, use this via Admin API:
-- POST https://your-project.supabase.co/auth/v1/admin/users
-- {
--   "email": "mithil20056mistry@gmail.com",
--   "password": "qwertyui",
--   "email_confirm": true
-- }

-- Option 2: If user already exists in auth.users, just update the profile:
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
    -- User exists, update/create profile with master admin flag
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

    RAISE NOTICE '✓ Master admin profile created/updated for user: %', master_admin_email;
    RAISE NOTICE '✓ User ID: %', master_admin_user_id;
  ELSE
    RAISE NOTICE '✗ User does not exist in auth.users with email: %', master_admin_email;
    RAISE NOTICE 'Please create the user first:';
    RAISE NOTICE '1. Go to Supabase Dashboard > Authentication > Users';
    RAISE NOTICE '2. Click "Add User"';
    RAISE NOTICE '3. Email: mithil20056mistry@gmail.com';
    RAISE NOTICE '4. Password: qwertyui';
    RAISE NOTICE '5. Then run this script again';
    RAISE NOTICE '';
    RAISE NOTICE 'OR use Supabase Admin API to create the user programmatically';
  END IF;
END $$;

-- ============================================================================
-- MANUAL UPDATE (if user already exists)
-- ============================================================================
-- If the user already exists, you can run this directly:
-- 
-- UPDATE public.profiles 
-- SET is_master_admin = true, name = 'Master Admin'
-- WHERE email = 'mithil20056mistry@gmail.com';
--
-- INSERT INTO public.master_admin_memberships (user_id, is_active)
-- SELECT user_id, true FROM public.profiles WHERE email = 'mithil20056mistry@gmail.com'
-- ON CONFLICT (user_id) DO UPDATE SET is_active = true;
-- ============================================================================

