-- 290529_1201_storage_policies_direct_connection.sql
-- =============================================================================
-- DO NOT run in Supabase Dashboard SQL Editor (no storage.objects owner rights).
--
-- Run with direct postgres connection:
--   npm run post-restore:storage-policies
--
-- Requires in .env:
--   DATABASE_DIRECT_URL=postgresql://postgres:***REMOVED-SENSITIVE-VALUE***@db.kqlqirdneocivumdjtvx.supabase.co:5432/postgres
-- (Dashboard → Project Settings → Database → Connection string → Direct)
-- =============================================================================

DROP POLICY IF EXISTS "receipts_select_policy" ON storage.objects;
DROP POLICY IF EXISTS "receipts_insert_policy" ON storage.objects;
DROP POLICY IF EXISTS "receipts_update_policy" ON storage.objects;
DROP POLICY IF EXISTS "receipts_delete_policy" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can view expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can update their own expense attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete their own expense attachments" ON storage.objects;

CREATE POLICY "receipts_select_policy"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      (
        (storage.foldername(name))[1] = 'temp' AND
        (storage.foldername(name))[2] = auth.uid()::text AND
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
      ) OR
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE (
          e.id::text = (storage.foldername(name))[1]
          OR (
            (storage.foldername(name))[1] = 'temp'
            AND (storage.foldername(name))[2] = auth.uid()::text
          )
        )
        AND om.user_id = auth.uid()
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
    )
  );

CREATE POLICY "receipts_insert_policy"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      (
        (storage.foldername(name))[1] = 'temp' AND
        (storage.foldername(name))[2] = auth.uid()::text AND
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
      ) OR
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

CREATE POLICY "receipts_update_policy"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      (
        (storage.foldername(name))[1] = 'temp' AND
        (storage.foldername(name))[2] = auth.uid()::text AND
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
      ) OR
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND e.user_id = auth.uid()
          AND om.user_id = auth.uid()
          AND om.is_active = true
          AND e.status = 'submitted'
      )
    )
  );

CREATE POLICY "receipts_delete_policy"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'receipts' AND
    auth.uid() IS NOT NULL AND
    (
      (
        (storage.foldername(name))[1] = 'temp' AND
        (storage.foldername(name))[2] = auth.uid()::text AND
        EXISTS (
          SELECT 1 FROM public.organization_memberships
          WHERE user_id = auth.uid() AND is_active = true
        )
      ) OR
      EXISTS (
        SELECT 1 FROM public.expenses e
        INNER JOIN public.organization_memberships om ON e.organization_id = om.organization_id
        WHERE e.id::text = (storage.foldername(name))[1]
          AND e.user_id = auth.uid()
          AND om.user_id = auth.uid()
          AND om.is_active = true
          AND e.status = 'submitted'
      ) OR
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

CREATE POLICY "Users can view expense attachments"
  ON storage.objects FOR SELECT
  TO authenticated
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

CREATE POLICY "Users can upload expense attachments"
  ON storage.objects FOR INSERT
  TO authenticated
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

CREATE POLICY "Users can update their own expense attachments"
  ON storage.objects FOR UPDATE
  TO authenticated
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

CREATE POLICY "Users can delete their own expense attachments"
  ON storage.objects FOR DELETE
  TO authenticated
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
      ) OR
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
