-- Ensure only admins can create, update, and delete expense categories
-- Update existing policies to use has_role function for consistency

-- Drop existing policies
DROP POLICY IF EXISTS exp_cat_admin_ins ON public.expense_categories;
DROP POLICY IF EXISTS exp_cat_admin_upd ON public.expense_categories;
DROP POLICY IF EXISTS exp_cat_admin_del ON public.expense_categories;
DROP POLICY IF EXISTS exp_cat_read ON public.expense_categories;

-- Read policy: Everyone can read active categories
CREATE POLICY exp_cat_read ON public.expense_categories
FOR SELECT
USING (active = true);

-- Insert policy: Only admins can create categories
CREATE POLICY exp_cat_admin_insert ON public.expense_categories
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Update policy: Only admins can update categories
CREATE POLICY exp_cat_admin_update ON public.expense_categories
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Delete policy: Only admins can delete categories
CREATE POLICY exp_cat_admin_delete ON public.expense_categories
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

