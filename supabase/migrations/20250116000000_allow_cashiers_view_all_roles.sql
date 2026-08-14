-- Allow cashiers and admins to view all user roles
-- This is needed for the Balances page where cashiers need to see all users' roles

-- Drop existing policy if it exists and create a new one that includes cashiers
DROP POLICY IF EXISTS "Admins can view all roles" ON public.user_roles;

-- Create policy that allows both admins and cashiers to view all roles
CREATE POLICY "Admins and cashiers can view all roles"
  ON public.user_roles FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR 
    public.has_role(auth.uid(), 'cashier')
  );

