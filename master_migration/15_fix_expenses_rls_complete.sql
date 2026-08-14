-- ============================================================================
-- MIGRATION: Complete Fix for Expenses RLS Policies
-- ============================================================================
-- This migration fixes ALL RLS policies for expenses table to ensure:
-- 1. Engineers can approve/reject expenses
-- 2. Users can create expenses
-- 3. All policies use direct queries (no function calls that might fail)
-- 4. Organization isolation is properly enforced
-- ============================================================================

-- ============================================================================
-- PART 1: DROP ALL EXISTING EXPENSES POLICIES
-- ============================================================================

-- Drop all existing policies on expenses table
DROP POLICY IF EXISTS "Users can view their own expenses" ON public.expenses;
DROP POLICY IF EXISTS "Engineers can view assigned expenses" ON public.expenses;
DROP POLICY IF EXISTS "Admins can view all expenses" ON public.expenses;
DROP POLICY IF EXISTS "Employees can create expenses" ON public.expenses;
DROP POLICY IF EXISTS "Users can update their submitted expenses" ON public.expenses;
DROP POLICY IF EXISTS "Users can update their draft expenses" ON public.expenses;
DROP POLICY IF EXISTS "Admins can update any expense" ON public.expenses;
DROP POLICY IF EXISTS "Engineers can update assigned expenses" ON public.expenses;
DROP POLICY IF EXISTS "Users can delete their submitted expenses" ON public.expenses;
DROP POLICY IF EXISTS "Admins can delete any expense" ON public.expenses;

-- ============================================================================
-- PART 2: CREATE SELECT POLICIES (VIEW)
-- ============================================================================

-- Policy: Users can view their own expenses
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

-- Policy: Engineers can view expenses assigned to them
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

-- Policy: Engineers can view all expenses in their organization (for review page)
CREATE POLICY "Engineers can view all org expenses"
  ON public.expenses FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
  );

-- Policy: Admins can view all expenses in their organization
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

-- ============================================================================
-- PART 3: CREATE INSERT POLICIES (CREATE)
-- ============================================================================

-- Policy: Users can create expenses
CREATE POLICY "Users can create expenses"
  ON public.expenses FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 4: CREATE UPDATE POLICIES (UPDATE/APPROVE/REJECT)
-- ============================================================================

-- Policy: Users can update their own submitted expenses (to edit before approval)
CREATE POLICY "Users can update their own submitted expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = user_id
    AND status = 'submitted'
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  );

-- Policy: Engineers can update expenses assigned to them (APPROVE/REJECT/REVIEW)
CREATE POLICY "Engineers can update assigned expenses"
  ON public.expenses FOR UPDATE
  USING (
    auth.uid() = assigned_engineer_id
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    auth.uid() = assigned_engineer_id
    AND organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
  );

-- Policy: Engineers can update any expense in their organization (for review page)
CREATE POLICY "Engineers can update any org expense"
  ON public.expenses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'engineer'
        AND om.is_active = true
    )
  );

-- Policy: Admins can update any expense in their organization
CREATE POLICY "Admins can update any expense"
  ON public.expenses FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 5: CREATE DELETE POLICIES
-- ============================================================================

-- Policy: Users can delete their own submitted expenses
CREATE POLICY "Users can delete their own submitted expenses"
  ON public.expenses FOR DELETE
  USING (
    auth.uid() = user_id
    AND status = 'submitted'
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.is_active = true
    )
  );

-- Policy: Admins can delete any expense in their organization
CREATE POLICY "Admins can delete any expense"
  ON public.expenses FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expenses.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ============================================================================
-- PART 6: VERIFY RLS IS ENABLED
-- ============================================================================

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- All expenses RLS policies have been fixed:
-- ✅ Engineers can approve/reject expenses
-- ✅ Engineers can view all expenses in their organization
-- ✅ Users can create expenses
-- ✅ Organization isolation is enforced
-- ✅ All policies use direct queries (no function calls)
-- ============================================================================

