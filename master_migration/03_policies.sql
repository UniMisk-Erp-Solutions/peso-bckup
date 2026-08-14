-- ============================================================================
-- PART 3: POLICIES, STORAGE, AND DEFAULT DATA
-- ============================================================================
-- This file creates all RLS policies, storage buckets, storage policies, grants, and default data
-- Run this file after 02_schema.sql

-- ============================================================================
-- PART 1: RLS POLICIES - PROFILES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can update any profile" ON public.profiles;
CREATE POLICY "Admins can update any profile"
  ON public.profiles FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can insert profiles" ON public.profiles;
CREATE POLICY "Admins can insert profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can delete profiles" ON public.profiles;
CREATE POLICY "Admins can delete profiles"
  ON public.profiles FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Engineers can view managed profiles" ON public.profiles;
CREATE POLICY "Engineers can view managed profiles"
  ON public.profiles FOR SELECT
  USING (
    reporting_engineer_id = auth.uid()
  );

-- ============================================================================
-- PART 2: RLS POLICIES - USER ROLES
-- ============================================================================

DROP POLICY IF EXISTS "Admins and cashiers can view all roles" ON public.user_roles;
CREATE POLICY "Admins and cashiers can view all roles"
  ON public.user_roles FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR 
    public.has_role(auth.uid(), 'cashier')
  );

DROP POLICY IF EXISTS "Admins can manage roles" ON public.user_roles;
CREATE POLICY "Admins can manage roles"
  ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Users can view their own roles" ON public.user_roles;
CREATE POLICY "Users can view their own roles"
  ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own roles" ON public.user_roles;
CREATE POLICY "Users can insert their own roles"
  ON public.user_roles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own roles" ON public.user_roles;
CREATE POLICY "Users can update their own roles"
  ON public.user_roles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Engineers and employees can view cashier and admin roles" ON public.user_roles;
CREATE POLICY "Engineers and employees can view cashier and admin roles"
  ON public.user_roles FOR SELECT
  USING (
    (public.has_role(auth.uid(), 'engineer') OR public.has_role(auth.uid(), 'employee'))
    AND role IN ('cashier', 'admin')
  );

DROP POLICY IF EXISTS "Cashiers can view admin roles" ON public.user_roles;
CREATE POLICY "Cashiers can view admin roles"
  ON public.user_roles FOR SELECT
  USING (
    public.has_role(auth.uid(), 'cashier')
    AND role = 'admin'
  );

-- ============================================================================
-- PART 3: RLS POLICIES - EXPENSES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own expenses" ON public.expenses;
CREATE POLICY "Users can view their own expenses"
  ON public.expenses FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Engineers can view assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    auth.uid() = assigned_engineer_id AND
    public.has_role(auth.uid(), 'engineer')
  );

DROP POLICY IF EXISTS "Admins can view all expenses" ON public.expenses;
CREATE POLICY "Admins can view all expenses"
  ON public.expenses FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Employees can create expenses" ON public.expenses;
CREATE POLICY "Employees can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id AND
    (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'admin'))
  );

DROP POLICY IF EXISTS "Users can update their submitted expenses" ON public.expenses;
CREATE POLICY "Users can update their submitted expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id AND
    status = 'submitted'
  )
  WITH CHECK (
    auth.uid() = user_id AND
    status = 'submitted'
  );

DROP POLICY IF EXISTS "Admins can update any expense" ON public.expenses;
CREATE POLICY "Admins can update any expense"
  ON public.expenses FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Engineers can update assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = assigned_engineer_id AND
    public.has_role(auth.uid(), 'engineer') AND
    status = 'submitted'
  )
  WITH CHECK (
    auth.uid() = assigned_engineer_id AND
    public.has_role(auth.uid(), 'engineer') AND
    status = 'verified'
  );

DROP POLICY IF EXISTS "Users can delete their submitted expenses" ON public.expenses;
CREATE POLICY "Users can delete their submitted expenses"
  ON public.expenses FOR DELETE
  USING (
    auth.uid() = user_id AND
    status = 'submitted'
  );

DROP POLICY IF EXISTS "Admins can delete any expense" ON public.expenses;
CREATE POLICY "Admins can delete any expense"
  ON public.expenses FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 4: RLS POLICIES - EXPENSE LINE ITEMS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view line items of viewable expenses" ON public.expense_line_items;
CREATE POLICY "Users can view line items of viewable expenses"
  ON public.expense_line_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

DROP POLICY IF EXISTS "Users can insert line items for their expenses" ON public.expense_line_items;
CREATE POLICY "Users can insert line items for their expenses"
  ON public.expense_line_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
      AND status = 'draft'
    )
  );

DROP POLICY IF EXISTS "Users can update line items for their draft expenses" ON public.expense_line_items;
CREATE POLICY "Users can update line items for their draft expenses"
  ON public.expense_line_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
      AND status = 'draft'
    )
  );

DROP POLICY IF EXISTS "Users can delete line items from their draft expenses" ON public.expense_line_items;
CREATE POLICY "Users can delete line items from their draft expenses"
  ON public.expense_line_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND user_id = auth.uid()
      AND status = 'draft'
    )
  );

-- ============================================================================
-- PART 5: RLS POLICIES - ATTACHMENTS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view attachments of viewable expenses" ON public.attachments;
CREATE POLICY "Users can view attachments of viewable expenses"
  ON public.attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

DROP POLICY IF EXISTS "Users can upload attachments for their expenses" ON public.attachments;
CREATE POLICY "Users can upload attachments for their expenses"
  ON public.attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND user_id = auth.uid()
    ) AND uploaded_by = auth.uid()
  );

DROP POLICY IF EXISTS "Users can delete attachments for their expenses" ON public.attachments;
CREATE POLICY "Users can delete attachments for their expenses"
  ON public.attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND user_id = auth.uid()
      AND status = 'submitted'
    )
  );

DROP POLICY IF EXISTS "Admins can delete any attachment" ON public.attachments;
CREATE POLICY "Admins can delete any attachment"
  ON public.attachments FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 6: RLS POLICIES - AUDIT LOGS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view audit logs of viewable expenses" ON public.audit_logs;
CREATE POLICY "Users can view audit logs of viewable expenses"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = audit_logs.expense_id
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        public.has_role(auth.uid(), 'admin')
      )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can create audit logs" ON public.audit_logs;
CREATE POLICY "Authenticated users can create audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete audit logs for their expenses" ON public.audit_logs;
CREATE POLICY "Users can delete audit logs for their expenses"
  ON public.audit_logs FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = audit_logs.expense_id
      AND user_id = auth.uid()
      AND status = 'submitted'
    )
  );

DROP POLICY IF EXISTS "Admins can delete any audit logs" ON public.audit_logs;
CREATE POLICY "Admins can delete any audit logs"
  ON public.audit_logs FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 7: RLS POLICIES - EXPENSE CATEGORIES
-- ============================================================================

DROP POLICY IF EXISTS exp_cat_read ON public.expense_categories;
CREATE POLICY exp_cat_read ON public.expense_categories
FOR SELECT
USING (active = true);

DROP POLICY IF EXISTS exp_cat_admin_insert ON public.expense_categories;
CREATE POLICY exp_cat_admin_insert ON public.expense_categories
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS exp_cat_admin_update ON public.expense_categories;
CREATE POLICY exp_cat_admin_update ON public.expense_categories
FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS exp_cat_admin_delete ON public.expense_categories;
CREATE POLICY exp_cat_admin_delete ON public.expense_categories
FOR DELETE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 8: RLS POLICIES - SETTINGS
-- ============================================================================

DROP POLICY IF EXISTS "Admins can view settings" ON public.settings;
CREATE POLICY "Admins can view settings"
  ON public.settings FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Engineers can view settings" ON public.settings;
CREATE POLICY "Engineers can view settings"
  ON public.settings FOR SELECT
  USING (public.has_role(auth.uid(), 'engineer'));

DROP POLICY IF EXISTS "Authenticated users can view settings" ON public.settings;
CREATE POLICY "Authenticated users can view settings"
  ON public.settings FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Admins can update settings" ON public.settings;
CREATE POLICY "Admins can update settings"
  ON public.settings FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can insert settings" ON public.settings;
CREATE POLICY "Admins can insert settings"
  ON public.settings FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ============================================================================
-- PART 9: RLS POLICIES - NOTIFICATIONS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;
CREATE POLICY "Users can view their own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;
CREATE POLICY "Users can update their own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Authenticated users can create notifications" ON public.notifications;
CREATE POLICY "Authenticated users can create notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- ============================================================================
-- PART 10: RLS POLICIES - MONEY ASSIGNMENTS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own assignments" ON public.money_assignments;
CREATE POLICY "Users can view their own assignments"
  ON public.money_assignments FOR SELECT
  USING (auth.uid() = recipient_id OR auth.uid() = cashier_id);

DROP POLICY IF EXISTS "Cashiers and admins can create assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can create assignments"
  ON public.money_assignments FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND auth.uid() = cashier_id
  );

DROP POLICY IF EXISTS "Cashiers and admins can update assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can update assignments"
  ON public.money_assignments FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'cashier') OR 
    public.has_role(auth.uid(), 'admin')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'cashier') OR 
    public.has_role(auth.uid(), 'admin')
  );

-- ============================================================================
-- PART 11: RLS POLICIES - LOCATIONS
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read locations" ON public.locations;
CREATE POLICY "Allow authenticated users to read locations"
  ON public.locations
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Only admins can insert locations" ON public.locations;
CREATE POLICY "Only admins can insert locations"
  ON public.locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can update locations" ON public.locations;
CREATE POLICY "Only admins can update locations"
  ON public.locations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can delete locations" ON public.locations;
CREATE POLICY "Only admins can delete locations"
  ON public.locations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================================
-- PART 12: RLS POLICIES - ENGINEER LOCATIONS
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read engineer_locations" ON public.engineer_locations;
CREATE POLICY "Allow authenticated users to read engineer_locations"
  ON public.engineer_locations
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Only admins can insert engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can insert engineer_locations"
  ON public.engineer_locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can update engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can update engineer_locations"
  ON public.engineer_locations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can delete engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can delete engineer_locations"
  ON public.engineer_locations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================================
-- PART 13: RLS POLICIES - MONEY RETURN REQUESTS
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own return requests" ON public.money_return_requests;
CREATE POLICY "Users can view their own return requests"
  ON public.money_return_requests FOR SELECT
  USING (auth.uid() = requester_id OR auth.uid() = cashier_id);

DROP POLICY IF EXISTS "Employees and engineers can create return requests" ON public.money_return_requests;
CREATE POLICY "Employees and engineers can create return requests"
  ON public.money_return_requests FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'engineer'))
    AND auth.uid() = requester_id
  );

DROP POLICY IF EXISTS "Cashiers can update return requests" ON public.money_return_requests;
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests FOR UPDATE
  USING (
    (public.has_role(auth.uid(), 'cashier') OR public.has_role(auth.uid(), 'admin'))
    AND auth.uid() = cashier_id
  );

-- ============================================================================
-- PART 14: STORAGE BUCKETS
-- ============================================================================

-- Receipts bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts',
  'receipts',
  true,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
)
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['image/jpeg', 'image/jpg', 'image/png'];

-- Expense attachments bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-attachments',
  'expense-attachments',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/jpg', 'image/png']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- PART 15: STORAGE POLICIES - RECEIPTS BUCKET
-- ============================================================================

DROP POLICY IF EXISTS "receipts_select_policy" ON storage.objects;
CREATE POLICY "receipts_select_policy"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'receipts');

DROP POLICY IF EXISTS "receipts_insert_policy" ON storage.objects;
CREATE POLICY "receipts_insert_policy"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "receipts_update_policy" ON storage.objects;
CREATE POLICY "receipts_update_policy"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "receipts_delete_policy" ON storage.objects;
CREATE POLICY "receipts_delete_policy"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL
  );

-- ============================================================================
-- PART 16: STORAGE POLICIES - EXPENSE ATTACHMENTS BUCKET
-- ============================================================================

DROP POLICY IF EXISTS "Users can upload expense attachments" ON storage.objects;
CREATE POLICY "Users can upload expense attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Users can view expense attachments" ON storage.objects;
CREATE POLICY "Users can view expense attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Users can update their own expense attachments" ON storage.objects;
CREATE POLICY "Users can update their own expense attachments"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

DROP POLICY IF EXISTS "Users can delete their own expense attachments" ON storage.objects;
CREATE POLICY "Users can delete their own expense attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL
  );

-- ============================================================================
-- PART 17: GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION get_original_cashier TO authenticated;
GRANT EXECUTE ON FUNCTION cashier_can_manage_employee TO authenticated;
GRANT EXECUTE ON FUNCTION sync_engineers_with_location_cashier TO authenticated;
GRANT EXECUTE ON FUNCTION get_cashier_for_engineer TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reset_user_password TO authenticated;

-- ============================================================================
-- PART 18: DEFAULT DATA
-- ============================================================================

-- Insert default engineer approval limit setting
INSERT INTO public.settings (key, value, description)
VALUES ('engineer_approval_limit', '50000', 'Maximum amount (in rupees) that engineers can approve directly. Expenses below this limit can be approved by engineers, above this limit must go to admin.')
ON CONFLICT (key) DO NOTHING;

-- Insert attachment required above amount setting
INSERT INTO public.settings (key, value, description)
VALUES ('attachment_required_above_amount', '50', 'Amount threshold (in rupees) above which bill attachments become mandatory. Expenses at or below this amount do not require attachments.')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- PART 19: COMMENTS
-- ============================================================================

COMMENT ON COLUMN public.expenses.category IS 'Expense category name from expense_categories table';
COMMENT ON COLUMN public.expenses.transaction_number IS 'Unique 5-digit transaction number for tracking expenses in Tally (e.g., 00001, 00002)';
COMMENT ON COLUMN public.profiles.balance IS 'Current balance of the user';
COMMENT ON COLUMN public.profiles.reporting_engineer_id IS 'Engineer assigned to manage this user';
COMMENT ON COLUMN public.profiles.cashier_assigned_engineer_id IS 'Tracks which engineer a cashier is assigned to, creating zones/departments. Cashiers can only manage employees under their assigned engineer.';
COMMENT ON COLUMN public.profiles.assigned_cashier_id IS 'Tracks which cashier an employee or engineer is assigned to. Employees and engineers return money to their assigned cashier.';
COMMENT ON COLUMN public.profiles.cashier_assigned_location_id IS 'Tracks which location a cashier is assigned to. All engineers in this location will be associated with this cashier.';
COMMENT ON TABLE public.money_assignments IS 'Tracks money flow from cashiers to employees and back, maintaining assignment history';
COMMENT ON FUNCTION get_original_cashier IS 'Returns the cashier_id who originally assigned money to a recipient, using FIFO for multiple assignments';
COMMENT ON FUNCTION cashier_can_manage_employee IS 'Checks if a cashier can manage a specific employee based on engineer assignments';
COMMENT ON TABLE public.locations IS 'Stores location information for organizing engineers and teams';
COMMENT ON TABLE public.engineer_locations IS 'Junction table for many-to-many relationship between engineers and locations';
COMMENT ON TABLE public.money_return_requests IS 'Tracks money return requests from employees/engineers to cashiers. Requires cashier approval before money is transferred.';

