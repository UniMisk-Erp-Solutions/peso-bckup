-- Allow engineers and employees to view cashier and admin roles
-- This is needed for the "Return Money" feature where engineers/employees need to find cashiers
-- and cashiers need to find admins

-- Drop existing policy if it exists
DROP POLICY IF EXISTS "Engineers and employees can view cashier and admin roles" ON public.user_roles;

-- Create policy that allows engineers and employees to view cashier and admin roles
CREATE POLICY "Engineers and employees can view cashier and admin roles"
  ON public.user_roles FOR SELECT
  USING (
    (public.has_role(auth.uid(), 'engineer') OR public.has_role(auth.uid(), 'employee'))
    AND role IN ('cashier', 'admin')
  );

-- Also allow cashiers to view admin roles (for cashier to admin returns)
DROP POLICY IF EXISTS "Cashiers can view admin roles" ON public.user_roles;

CREATE POLICY "Cashiers can view admin roles"
  ON public.user_roles FOR SELECT
  USING (
    public.has_role(auth.uid(), 'cashier')
    AND role = 'admin'
  );

