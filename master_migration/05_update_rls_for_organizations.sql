-- ============================================================================
-- PART 5: UPDATE EXISTING RLS POLICIES FOR ORGANIZATIONS
-- ============================================================================
-- This file updates all existing RLS policies to include organization_id checks
-- Run this AFTER 04_saas_multi_tenancy.sql

-- ============================================================================
-- PART 1: UPDATE PROFILES POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  USING (
    auth.uid() IS NOT NULL 
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (
    auth.uid() = user_id 
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Admins can update any profile" ON public.profiles;
CREATE POLICY "Admins can update any profile"
  ON public.profiles FOR UPDATE
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Admins can insert profiles" ON public.profiles;
CREATE POLICY "Admins can insert profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Admins can delete profiles" ON public.profiles;
CREATE POLICY "Admins can delete profiles"
  ON public.profiles FOR DELETE
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Engineers can view managed profiles" ON public.profiles;
CREATE POLICY "Engineers can view managed profiles"
  ON public.profiles FOR SELECT
  USING (
    reporting_engineer_id = auth.uid()
    AND organization_id = get_user_organization_id()
  );

-- ============================================================================
-- PART 2: UPDATE USER ROLES POLICIES
-- ============================================================================

-- Note: user_roles table doesn't have organization_id, but we check via organization_memberships
-- Keep existing policies but they'll work through organization_memberships

-- ============================================================================
-- PART 3: UPDATE EXPENSES POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own expenses" ON public.expenses;
CREATE POLICY "Users can view their own expenses"
  ON public.expenses FOR SELECT
  USING (
    auth.uid() = user_id 
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Engineers can view assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    auth.uid() = assigned_engineer_id 
    AND organization_id = get_user_organization_id()
    AND has_org_role('engineer')
  );

DROP POLICY IF EXISTS "Admins can view all expenses" ON public.expenses;
CREATE POLICY "Admins can view all expenses"
  ON public.expenses FOR SELECT
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Employees can create expenses" ON public.expenses;
CREATE POLICY "Employees can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id 
    AND organization_id = get_user_organization_id()
    AND (has_org_role('employee') OR has_org_role('admin'))
  );

DROP POLICY IF EXISTS "Users can update their submitted expenses" ON public.expenses;
CREATE POLICY "Users can update their submitted expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id 
    AND status = 'submitted'
    AND organization_id = get_user_organization_id()
  )
  WITH CHECK (
    auth.uid() = user_id 
    AND status = 'submitted'
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Admins can update any expense" ON public.expenses;
CREATE POLICY "Admins can update any expense"
  ON public.expenses FOR UPDATE
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Engineers can update assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = assigned_engineer_id 
    AND organization_id = get_user_organization_id()
    AND has_org_role('engineer') 
    AND status = 'submitted'
  )
  WITH CHECK (
    auth.uid() = assigned_engineer_id 
    AND organization_id = get_user_organization_id()
    AND has_org_role('engineer') 
    AND status = 'verified'
  );

DROP POLICY IF EXISTS "Users can delete their submitted expenses" ON public.expenses;
CREATE POLICY "Users can delete their submitted expenses"
  ON public.expenses FOR DELETE
  USING (
    auth.uid() = user_id 
    AND status = 'submitted'
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Admins can delete any expense" ON public.expenses;
CREATE POLICY "Admins can delete any expense"
  ON public.expenses FOR DELETE
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

-- ============================================================================
-- PART 4: UPDATE EXPENSE LINE ITEMS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view line items of viewable expenses" ON public.expense_line_items;
CREATE POLICY "Users can view line items of viewable expenses"
  ON public.expense_line_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = expense_line_items.expense_id
      AND organization_id = get_user_organization_id()
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        has_org_role('admin')
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
      AND organization_id = get_user_organization_id()
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
      AND organization_id = get_user_organization_id()
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
      AND organization_id = get_user_organization_id()
    )
  );

-- ============================================================================
-- PART 5: UPDATE ATTACHMENTS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view attachments of viewable expenses" ON public.attachments;
CREATE POLICY "Users can view attachments of viewable expenses"
  ON public.attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = attachments.expense_id
      AND organization_id = get_user_organization_id()
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        has_org_role('admin')
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
      AND organization_id = get_user_organization_id()
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
      AND organization_id = get_user_organization_id()
    )
  );

DROP POLICY IF EXISTS "Admins can delete any attachment" ON public.attachments;
CREATE POLICY "Admins can delete any attachment"
  ON public.attachments FOR DELETE
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

-- ============================================================================
-- PART 6: UPDATE AUDIT LOGS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view audit logs of viewable expenses" ON public.audit_logs;
CREATE POLICY "Users can view audit logs of viewable expenses"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = audit_logs.expense_id
      AND organization_id = get_user_organization_id()
      AND (
        user_id = auth.uid() OR
        assigned_engineer_id = auth.uid() OR
        has_org_role('admin')
      )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can create audit logs" ON public.audit_logs;
CREATE POLICY "Authenticated users can create audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (
    auth.uid() = user_id 
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Users can delete audit logs for their expenses" ON public.audit_logs;
CREATE POLICY "Users can delete audit logs for their expenses"
  ON public.audit_logs FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses
      WHERE id = audit_logs.expense_id
      AND user_id = auth.uid()
      AND status = 'submitted'
      AND organization_id = get_user_organization_id()
    )
  );

DROP POLICY IF EXISTS "Admins can delete any audit logs" ON public.audit_logs;
CREATE POLICY "Admins can delete any audit logs"
  ON public.audit_logs FOR DELETE
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

-- ============================================================================
-- PART 7: UPDATE EXPENSE CATEGORIES POLICIES
-- ============================================================================

DROP POLICY IF EXISTS exp_cat_read ON public.expense_categories;
CREATE POLICY exp_cat_read ON public.expense_categories
FOR SELECT
USING (
  active = true 
  AND organization_id = get_user_organization_id()
);

DROP POLICY IF EXISTS exp_cat_admin_insert ON public.expense_categories;
CREATE POLICY exp_cat_admin_insert ON public.expense_categories
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id = get_user_organization_id() 
  AND has_org_role('admin')
);

DROP POLICY IF EXISTS exp_cat_admin_update ON public.expense_categories;
CREATE POLICY exp_cat_admin_update ON public.expense_categories
FOR UPDATE
TO authenticated
USING (
  organization_id = get_user_organization_id() 
  AND has_org_role('admin')
)
WITH CHECK (
  organization_id = get_user_organization_id() 
  AND has_org_role('admin')
);

DROP POLICY IF EXISTS exp_cat_admin_delete ON public.expense_categories;
CREATE POLICY exp_cat_admin_delete ON public.expense_categories
FOR DELETE
TO authenticated
USING (
  organization_id = get_user_organization_id() 
  AND has_org_role('admin')
);

-- ============================================================================
-- PART 8: UPDATE SETTINGS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Admins can view settings" ON public.settings;
CREATE POLICY "Admins can view settings"
  ON public.settings FOR SELECT
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Engineers can view settings" ON public.settings;
CREATE POLICY "Engineers can view settings"
  ON public.settings FOR SELECT
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('engineer')
  );

DROP POLICY IF EXISTS "Authenticated users can view settings" ON public.settings;
CREATE POLICY "Authenticated users can view settings"
  ON public.settings FOR SELECT
  USING (
    organization_id = get_user_organization_id() 
    AND auth.role() = 'authenticated'
  );

DROP POLICY IF EXISTS "Admins can update settings" ON public.settings;
CREATE POLICY "Admins can update settings"
  ON public.settings FOR UPDATE
  USING (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Admins can insert settings" ON public.settings;
CREATE POLICY "Admins can insert settings"
  ON public.settings FOR INSERT
  WITH CHECK (
    organization_id = get_user_organization_id() 
    AND has_org_role('admin')
  );

-- ============================================================================
-- PART 9: UPDATE NOTIFICATIONS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;
CREATE POLICY "Users can view their own notifications"
  ON public.notifications FOR SELECT
  USING (
    auth.uid() = user_id 
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;
CREATE POLICY "Users can update their own notifications"
  ON public.notifications FOR UPDATE
  USING (
    auth.uid() = user_id 
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Authenticated users can create notifications" ON public.notifications;
CREATE POLICY "Authenticated users can create notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated' 
    AND organization_id = get_user_organization_id()
  );

-- ============================================================================
-- PART 10: UPDATE MONEY ASSIGNMENTS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own assignments" ON public.money_assignments;
CREATE POLICY "Users can view their own assignments"
  ON public.money_assignments FOR SELECT
  USING (
    (auth.uid() = recipient_id OR auth.uid() = cashier_id)
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Cashiers and admins can create assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can create assignments"
  ON public.money_assignments FOR INSERT
  WITH CHECK (
    (has_org_role('cashier') OR has_org_role('admin'))
    AND auth.uid() = cashier_id
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Cashiers and admins can update assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can update assignments"
  ON public.money_assignments FOR UPDATE
  USING (
    (has_org_role('cashier') OR has_org_role('admin'))
    AND organization_id = get_user_organization_id()
  )
  WITH CHECK (
    (has_org_role('cashier') OR has_org_role('admin'))
    AND organization_id = get_user_organization_id()
  );

-- ============================================================================
-- PART 11: UPDATE LOCATIONS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read locations" ON public.locations;
CREATE POLICY "Allow authenticated users to read locations"
  ON public.locations
  FOR SELECT
  TO authenticated
  USING (
    organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Only admins can insert locations" ON public.locations;
CREATE POLICY "Only admins can insert locations"
  ON public.locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = get_user_organization_id()
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Only admins can update locations" ON public.locations;
CREATE POLICY "Only admins can update locations"
  ON public.locations
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = get_user_organization_id()
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Only admins can delete locations" ON public.locations;
CREATE POLICY "Only admins can delete locations"
  ON public.locations
  FOR DELETE
  TO authenticated
  USING (
    organization_id = get_user_organization_id()
    AND has_org_role('admin')
  );

-- ============================================================================
-- PART 12: UPDATE ENGINEER LOCATIONS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read engineer_locations" ON public.engineer_locations;
CREATE POLICY "Allow authenticated users to read engineer_locations"
  ON public.engineer_locations
  FOR SELECT
  TO authenticated
  USING (
    organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Only admins can insert engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can insert engineer_locations"
  ON public.engineer_locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = get_user_organization_id()
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Only admins can update engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can update engineer_locations"
  ON public.engineer_locations
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = get_user_organization_id()
    AND has_org_role('admin')
  );

DROP POLICY IF EXISTS "Only admins can delete engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can delete engineer_locations"
  ON public.engineer_locations
  FOR DELETE
  TO authenticated
  USING (
    organization_id = get_user_organization_id()
    AND has_org_role('admin')
  );

-- ============================================================================
-- PART 13: UPDATE MONEY RETURN REQUESTS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own return requests" ON public.money_return_requests;
CREATE POLICY "Users can view their own return requests"
  ON public.money_return_requests FOR SELECT
  USING (
    (auth.uid() = requester_id OR auth.uid() = cashier_id)
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Employees and engineers can create return requests" ON public.money_return_requests;
CREATE POLICY "Employees and engineers can create return requests"
  ON public.money_return_requests FOR INSERT
  WITH CHECK (
    (has_org_role('employee') OR has_org_role('engineer'))
    AND auth.uid() = requester_id
    AND organization_id = get_user_organization_id()
  );

DROP POLICY IF EXISTS "Cashiers can update return requests" ON public.money_return_requests;
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests FOR UPDATE
  USING (
    (has_org_role('cashier') OR has_org_role('admin'))
    AND auth.uid() = cashier_id
    AND organization_id = get_user_organization_id()
  );

