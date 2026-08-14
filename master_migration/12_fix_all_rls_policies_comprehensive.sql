-- ============================================================================
-- COMPREHENSIVE RLS POLICY FIXES
-- ============================================================================
-- This migration fixes ALL RLS policies to use direct queries instead of
-- function calls, ensuring proper organization isolation and avoiding NULL issues.
-- Run this after all other migrations.
-- ============================================================================

-- ============================================================================
-- PART 1: FIX ENGINEER_LOCATIONS POLICIES (using direct queries)
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read engineer_locations" ON public.engineer_locations;
CREATE POLICY "Allow authenticated users to read engineer_locations"
  ON public.engineer_locations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = engineer_locations.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Only admins can insert engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can insert engineer_locations"
  ON public.engineer_locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = engineer_locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Only admins can update engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can update engineer_locations"
  ON public.engineer_locations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = engineer_locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = engineer_locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Only admins can delete engineer_locations" ON public.engineer_locations;
CREATE POLICY "Only admins can delete engineer_locations"
  ON public.engineer_locations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = engineer_locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 2: FIX PROFILES POLICIES (ensure organization_id checks)
-- ============================================================================

DROP POLICY IF EXISTS "Users can view all profiles" ON public.profiles;
CREATE POLICY "Users can view all profiles"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.is_active = true
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
  );

DROP POLICY IF EXISTS "Admins can update any profile" ON public.profiles;
CREATE POLICY "Admins can update any profile"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert profiles" ON public.profiles;
CREATE POLICY "Admins can insert profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can delete profiles" ON public.profiles;
CREATE POLICY "Admins can delete profiles"
  ON public.profiles FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Engineers can view managed profiles" ON public.profiles;
CREATE POLICY "Engineers can view managed profiles"
  ON public.profiles FOR SELECT
  USING (
    reporting_engineer_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = profiles.organization_id
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 3: FIX LOCATIONS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Allow authenticated users to read locations" ON public.locations;
CREATE POLICY "Allow authenticated users to read locations"
  ON public.locations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = locations.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Only admins can insert locations" ON public.locations;
CREATE POLICY "Only admins can insert locations"
  ON public.locations
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Only admins can update locations" ON public.locations;
CREATE POLICY "Only admins can update locations"
  ON public.locations
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Only admins can delete locations" ON public.locations;
CREATE POLICY "Only admins can delete locations"
  ON public.locations
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = locations.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 4: FIX EXPENSE CATEGORIES POLICIES
-- ============================================================================

DROP POLICY IF EXISTS exp_cat_read ON public.expense_categories;
CREATE POLICY exp_cat_read ON public.expense_categories
FOR SELECT
USING (
  active = true 
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = expense_categories.organization_id
      AND om.is_active = true
  )
);

DROP POLICY IF EXISTS exp_cat_admin_insert ON public.expense_categories;
CREATE POLICY exp_cat_admin_insert ON public.expense_categories
FOR INSERT
TO authenticated
WITH CHECK (
  organization_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = expense_categories.organization_id
      AND om.role = 'admin'
      AND om.is_active = true
  )
);

DROP POLICY IF EXISTS exp_cat_admin_update ON public.expense_categories;
CREATE POLICY exp_cat_admin_update ON public.expense_categories
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = expense_categories.organization_id
      AND om.role = 'admin'
      AND om.is_active = true
  )
)
WITH CHECK (
  organization_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = expense_categories.organization_id
      AND om.role = 'admin'
      AND om.is_active = true
  )
);

DROP POLICY IF EXISTS exp_cat_admin_delete ON public.expense_categories;
CREATE POLICY exp_cat_admin_delete ON public.expense_categories
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = auth.uid()
      AND om.organization_id = expense_categories.organization_id
      AND om.role = 'admin'
      AND om.is_active = true
  )
);

-- ============================================================================
-- PART 5: FIX SETTINGS POLICIES (settings table)
-- ============================================================================

DROP POLICY IF EXISTS "Admins can view settings" ON public.settings;
CREATE POLICY "Admins can view settings"
  ON public.settings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = settings.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Engineers can view settings" ON public.settings;
CREATE POLICY "Engineers can view settings"
  ON public.settings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = settings.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Authenticated users can view settings" ON public.settings;
CREATE POLICY "Authenticated users can view settings"
  ON public.settings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = settings.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can update settings" ON public.settings;
CREATE POLICY "Admins can update settings"
  ON public.settings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = settings.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = settings.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can insert settings" ON public.settings;
CREATE POLICY "Admins can insert settings"
  ON public.settings FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = settings.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 6: FIX EXPENSES POLICIES (already fixed but ensure consistency)
-- ============================================================================

-- Expenses INSERT policy already fixed in 11_fix_expense_insert_rls.sql
-- But let's ensure SELECT policies also use direct queries

DROP POLICY IF EXISTS "Admins can view all expenses" ON public.expenses;
CREATE POLICY "Admins can view all expenses"
  ON public.expenses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Users can view their own expenses" ON public.expenses;
CREATE POLICY "Users can view their own expenses"
  ON public.expenses FOR SELECT
  USING (
    auth.uid() = user_id 
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Engineers can view assigned expenses" ON public.expenses;
CREATE POLICY "Engineers can view assigned expenses"
  ON public.expenses FOR SELECT
  USING (
    auth.uid() = assigned_engineer_id 
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 7: FIX ATTACHMENTS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view attachments of viewable expenses" ON public.attachments;
CREATE POLICY "Users can view attachments of viewable expenses"
  ON public.attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE e.id = attachments.expense_id
        AND om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.is_active = true
        AND (
          e.user_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.organization_memberships om2
            WHERE om2.user_id = auth.uid()
              AND om2.organization_id = e.organization_id
              AND om2.role = 'admin'
              AND om2.is_active = true
          )
        )
    )
  );

DROP POLICY IF EXISTS "Users can upload attachments for their expenses" ON public.attachments;
CREATE POLICY "Users can upload attachments for their expenses"
  ON public.attachments FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE e.id = attachments.expense_id
        AND e.user_id = auth.uid()
        AND om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.organization_id = attachments.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Users can delete attachments for their expenses" ON public.attachments;
CREATE POLICY "Users can delete attachments for their expenses"
  ON public.attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE e.id = attachments.expense_id
        AND e.user_id = auth.uid()
        AND e.status = 'submitted'
        AND om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.organization_id = attachments.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can delete any attachment" ON public.attachments;
CREATE POLICY "Admins can delete any attachment"
  ON public.attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = attachments.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 8: FIX AUDIT LOGS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view audit logs of viewable expenses" ON public.audit_logs;
CREATE POLICY "Users can view audit logs of viewable expenses"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE e.id = audit_logs.expense_id
        AND om.user_id = auth.uid()
        AND om.organization_id = e.organization_id
        AND om.organization_id = audit_logs.organization_id
        AND om.is_active = true
        AND (
          e.user_id = auth.uid()
          OR e.assigned_engineer_id = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.organization_memberships om2
            WHERE om2.user_id = auth.uid()
              AND om2.organization_id = e.organization_id
              AND om2.role = 'admin'
              AND om2.is_active = true
          )
        )
    )
  );

DROP POLICY IF EXISTS "Authenticated users can create audit logs" ON public.audit_logs;
CREATE POLICY "Authenticated users can create audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (
    auth.uid() = user_id 
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = audit_logs.organization_id
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 9: FIX MONEY ASSIGNMENTS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own assignments" ON public.money_assignments;
CREATE POLICY "Users can view their own assignments"
  ON public.money_assignments FOR SELECT
  USING (
    (auth.uid() = recipient_id OR auth.uid() = cashier_id)
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_assignments.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Cashiers and admins can create assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can create assignments"
  ON public.money_assignments FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND auth.uid() = cashier_id
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_assignments.organization_id
        AND om.role IN ('cashier', 'admin')
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Cashiers and admins can update assignments" ON public.money_assignments;
CREATE POLICY "Cashiers and admins can update assignments"
  ON public.money_assignments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_assignments.organization_id
        AND om.role IN ('cashier', 'admin')
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_assignments.organization_id
        AND om.role IN ('cashier', 'admin')
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 10: FIX MONEY RETURN REQUESTS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own return requests" ON public.money_return_requests;
CREATE POLICY "Users can view their own return requests"
  ON public.money_return_requests FOR SELECT
  USING (
    (auth.uid() = requester_id OR auth.uid() = cashier_id)
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Employees and engineers can create return requests" ON public.money_return_requests;
CREATE POLICY "Employees and engineers can create return requests"
  ON public.money_return_requests FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND auth.uid() = requester_id
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.role IN ('employee', 'engineer')
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Cashiers can update return requests" ON public.money_return_requests;
CREATE POLICY "Cashiers can update return requests"
  ON public.money_return_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.role IN ('cashier', 'admin')
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = money_return_requests.organization_id
        AND om.role IN ('cashier', 'admin')
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 11: FIX NOTIFICATIONS POLICIES
-- ============================================================================

DROP POLICY IF EXISTS "Users can view their own notifications" ON public.notifications;
CREATE POLICY "Users can view their own notifications"
  ON public.notifications FOR SELECT
  USING (
    auth.uid() = user_id 
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = notifications.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Users can update their own notifications" ON public.notifications;
CREATE POLICY "Users can update their own notifications"
  ON public.notifications FOR UPDATE
  USING (
    auth.uid() = user_id 
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = notifications.organization_id
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND auth.uid() = user_id
  );

DROP POLICY IF EXISTS "Authenticated users can create notifications" ON public.notifications;
CREATE POLICY "Authenticated users can create notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated' 
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = notifications.organization_id
        AND om.is_active = true
    )
  );

