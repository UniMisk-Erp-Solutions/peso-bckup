-- Add balance column to profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2) DEFAULT 0;

-- Update RLS policies to allow admins to manage profiles (including balance)
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- Allow admins to update any profile (for balance management)
CREATE POLICY "Admins can update any profile"
  ON public.profiles FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- Allow admins to view all profiles (for user management)
DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Allow admins to insert profiles (for user creation)
CREATE POLICY "Admins can insert profiles"
  ON public.profiles FOR INSERT
  USING (public.has_role(auth.uid(), 'admin'));

-- Allow admins to delete profiles (for user management)
CREATE POLICY "Admins can delete profiles"
  ON public.profiles FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));
