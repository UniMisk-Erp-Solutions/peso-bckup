-- ============================================================================
-- SETUP ADMIN ACCOUNT
-- ============================================================================
-- This script sets up admin@peso.com as an admin account
-- Run this after completing the migration (01_cleanup.sql, 02_schema.sql, 03_policies.sql)

DO $$
DECLARE
  admin_user_id UUID;
  admin_email TEXT := 'admin@peso.com';
BEGIN
  -- Find the user by email
  SELECT id INTO admin_user_id
  FROM auth.users
  WHERE email = admin_email
  LIMIT 1;

  -- If user doesn't exist, raise an error
  IF admin_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % does not exist. Please create the user first in Supabase Auth.', admin_email;
  END IF;

  -- Ensure profile exists (should be created by trigger, but just in case)
  INSERT INTO public.profiles (user_id, name, email, is_active)
  VALUES (admin_user_id, 'Admin User', admin_email, true)
  ON CONFLICT (user_id) DO UPDATE SET
    name = 'Admin User',
    email = admin_email,
    is_active = true;

  -- Add admin role (remove any existing roles first, then add admin)
  DELETE FROM public.user_roles
  WHERE user_id = admin_user_id;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (admin_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;

  RAISE NOTICE 'Successfully set up admin account for % (user_id: %)', admin_email, admin_user_id;
END $$;

-- Verify the admin account was created
SELECT 
  u.email,
  p.name,
  ur.role,
  p.is_active
FROM auth.users u
JOIN public.profiles p ON p.user_id = u.id
JOIN public.user_roles ur ON ur.user_id = u.id
WHERE u.email = 'admin@peso.com';

