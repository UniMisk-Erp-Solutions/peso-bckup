-- Delete all users except admin@bill.com
-- This migration removes all user accounts except the admin account
-- WARNING: This will permanently delete all users and their data except admin@bill.com

DO $$
DECLARE
  admin_user_id UUID;
BEGIN
  -- Find the admin user by email
  SELECT id INTO admin_user_id
  FROM auth.users
  WHERE email = 'admin@bill.com'
  LIMIT 1;

  -- If admin user doesn't exist, raise an error
  IF admin_user_id IS NULL THEN
    RAISE EXCEPTION 'Admin user with email admin@bill.com not found. Cannot proceed with deletion.';
  END IF;

  -- Delete all notifications for non-admin users
  DELETE FROM public.notifications
  WHERE user_id != admin_user_id;

  -- Delete all money return requests for non-admin users
  DELETE FROM public.money_return_requests
  WHERE requester_id != admin_user_id AND cashier_id != admin_user_id;

  -- Delete all money assignments for non-admin users
  DELETE FROM public.money_assignments
  WHERE cashier_id != admin_user_id AND recipient_id != admin_user_id;

  -- Delete all expenses for non-admin users (this cascades to attachments, audit_logs, etc.)
  DELETE FROM public.expenses
  WHERE user_id != admin_user_id;

  -- Delete all user roles except for admin user
  DELETE FROM public.user_roles
  WHERE user_id != admin_user_id;

  -- Delete all profiles except for admin user
  DELETE FROM public.profiles
  WHERE user_id != admin_user_id;

  -- Delete all auth users except admin
  -- Note: Deleting from auth.users requires service_role or superuser permissions
  -- If this fails, you can delete users manually from Supabase Dashboard:
  -- Dashboard → Authentication → Users → Delete each user except admin@bill.com
  -- Or use the Supabase Admin API with service_role key
  
  BEGIN
    DELETE FROM auth.users
    WHERE id != admin_user_id;
    
    RAISE NOTICE 'All auth users deleted except admin@bill.com (user_id: %)', admin_user_id;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE WARNING 'Cannot delete from auth.users directly. Please delete users manually from Supabase Dashboard (Authentication → Users) except admin@bill.com';
    WHEN OTHERS THEN
      RAISE WARNING 'Error deleting from auth.users: %. Please delete users manually from Supabase Dashboard.', SQLERRM;
  END;

  RAISE NOTICE 'Migration completed. Admin user preserved: admin@bill.com (user_id: %)', admin_user_id;
END $$;

