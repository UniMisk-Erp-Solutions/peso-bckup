-- Check and fix user roles
-- Run this in your Supabase Dashboard SQL Editor

-- 1. Check current user roles
SELECT 
  ur.user_id,
  p.name,
  p.email,
  ur.role,
  ur.created_at
FROM public.user_roles ur
JOIN public.profiles p ON ur.user_id = p.user_id
ORDER BY ur.created_at DESC;

-- 2. Check if the current user has any role
SELECT 
  auth.uid() as current_user_id,
  p.name,
  p.email,
  ur.role
FROM public.profiles p
LEFT JOIN public.user_roles ur ON p.user_id = ur.user_id
WHERE p.user_id = auth.uid();

-- 3. If no role exists, you can manually assign one
-- Replace 'YOUR_USER_ID_HERE' with the actual user ID from step 2
-- Uncomment and run one of these based on what role you want to assign:

-- For admin role:
-- INSERT INTO public.user_roles (user_id, role)
-- VALUES ('YOUR_USER_ID_HERE', 'admin')
-- ON CONFLICT (user_id, role) DO NOTHING;

-- For employee role:
-- INSERT INTO public.user_roles (user_id, role)
-- VALUES ('YOUR_USER_ID_HERE', 'employee')
-- ON CONFLICT (user_id, role) DO NOTHING;

-- 4. Check all policies that might be blocking the operation
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename = 'expense_line_items'
ORDER BY policyname;
