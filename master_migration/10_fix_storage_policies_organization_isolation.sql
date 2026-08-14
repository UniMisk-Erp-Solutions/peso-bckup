-- ============================================================================
-- FIX STORAGE POLICIES FOR ORGANIZATION ISOLATION
-- ============================================================================
-- This migration fixes storage policies to ensure files are properly isolated
-- by organization. Files can only be accessed by users from the same organization
-- as the expense they belong to.
-- ============================================================================

-- Drop existing storage policies for receipts bucket
DROP POLICY IF EXISTS "receipts_select_policy" ON storage.objects;
DROP POLICY IF EXISTS "receipts_insert_policy" ON storage.objects;
DROP POLICY IF EXISTS "receipts_update_policy" ON storage.objects;
DROP POLICY IF EXISTS "receipts_delete_policy" ON storage.objects;

-- Drop existing storage policies for expense-attachments bucket
DROP POLICY IF EXISTS "Users can upload expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can view expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own expense attachments" ON storage.objects;

-- ============================================================================
-- RECEIPTS BUCKET POLICIES (organization-scoped)
-- ============================================================================

-- SELECT: Users can view files if they belong to an expense in their organization
CREATE POLICY "receipts_select_policy"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      -- Allow viewing temp files for the user (during expense creation)
      (storage.foldername(name))[1] = 'temp' AND
      (storage.foldername(name))[2] = auth.uid()::text AND
      EXISTS (
        SELECT 1 FROM public.organization_memberships
        WHERE user_id = auth.uid() AND is_active = true
      )
    ) OR
    -- Allow viewing files if they belong to an expense in user's organization
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE (
        -- File path format: {expense_id}/{filename}
        e.id::text = (storage.foldername(name))[1]
        OR
        -- File path format: temp/{user_id}/{filename} (already handled above)
        (storage.foldername(name))[1] = 'temp' AND (storage.foldername(name))[2] = auth.uid()::text
      )
      AND om.user_id = auth.uid()
      AND om.is_active = true
      AND (
        -- User owns the expense
        e.user_id = auth.uid()
        OR
        -- User is assigned engineer
        e.assigned_engineer_id = auth.uid()
        OR
        -- User is admin in the organization
        EXISTS (
          SELECT 1 FROM public.organization_memberships om2
          WHERE om2.user_id = auth.uid()
            AND om2.organization_id = e.organization_id
            AND om2.role = 'admin'
            AND om2.is_active = true
        )
      )
    )
  );

-- INSERT: Users can upload files for expenses in their organization
CREATE POLICY "receipts_insert_policy"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      -- Allow uploading to temp folder for the user
      (
        (storage.foldername(name))[1] = 'temp' AND
        (storage.foldername(name))[2] = auth.uid()::text AND
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
      )
      OR
      -- Allow uploading to expense folder if user owns the expense
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND e.user_id = auth.uid()
          AND om.user_id = auth.uid()
          AND om.is_active = true
      )
    )
  );

-- UPDATE: Users can update files for their own expenses
CREATE POLICY "receipts_update_policy"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      -- Allow updating temp files for the user
      (
        (storage.foldername(name))[1] = 'temp' AND
        (storage.foldername(name))[2] = auth.uid()::text AND
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
      )
      OR
      -- Allow updating files if user owns the expense
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND e.user_id = auth.uid()
          AND om.user_id = auth.uid()
          AND om.is_active = true
          AND e.status = 'submitted' -- Only allow updates for submitted expenses
      )
    )
  );

-- DELETE: Users can delete files for their own expenses (if submitted)
CREATE POLICY "receipts_delete_policy"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      -- Allow deleting temp files for the user
      (
        (storage.foldername(name))[1] = 'temp' AND
        (storage.foldername(name))[2] = auth.uid()::text AND
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
      )
      OR
      -- Allow deleting files if user owns the expense and it's submitted
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND e.user_id = auth.uid()
          AND om.user_id = auth.uid()
          AND om.is_active = true
          AND e.status = 'submitted'
      )
      OR
      -- Admins can delete files from expenses in their organization
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND om.user_id = auth.uid()
          AND om.organization_id = e.organization_id
          AND om.role = 'admin'
          AND om.is_active = true
      )
    )
  );

-- ============================================================================
-- EXPENSE-ATTACHMENTS BUCKET POLICIES (organization-scoped)
-- ============================================================================
-- Note: This bucket may be legacy, but we'll secure it anyway

-- SELECT: Same as receipts bucket
CREATE POLICY "Users can view expense attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE e.id::text = (storage.foldername(name))[1]
        AND om.user_id = auth.uid()
        AND om.is_active = true
        AND (
          e.user_id = auth.uid()
          OR
          e.assigned_engineer_id = auth.uid()
          OR
          EXISTS (
            SELECT 1 FROM public.organization_memberships om2
            WHERE om2.user_id = auth.uid()
              AND om2.organization_id = e.organization_id
              AND om2.role = 'admin'
              AND om2.is_active = true
          )
        )
    )
  );

-- INSERT: Same as receipts bucket
CREATE POLICY "Users can upload expense attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE e.id::text = (storage.foldername(name))[1]
        AND e.user_id = auth.uid()
        AND om.user_id = auth.uid()
        AND om.is_active = true
    )
  );

-- UPDATE: Same as receipts bucket
CREATE POLICY "Users can update their own expense attachments"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
      WHERE e.id::text = (storage.foldername(name))[1]
        AND e.user_id = auth.uid()
        AND om.user_id = auth.uid()
        AND om.is_active = true
        AND e.status = 'submitted'
    )
  );

-- DELETE: Same as receipts bucket
CREATE POLICY "Users can delete their own expense attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'expense-attachments' AND
    auth.uid() IS NOT NULL AND
    (
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND e.user_id = auth.uid()
          AND om.user_id = auth.uid()
          AND om.is_active = true
          AND e.status = 'submitted'
      )
      OR
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND om.user_id = auth.uid()
          AND om.organization_id = e.organization_id
          AND om.role = 'admin'
          AND om.is_active = true
      )
    )
  );

