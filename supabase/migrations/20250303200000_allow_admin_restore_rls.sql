-- ============================================================================
-- RLS: Allow org admins to insert/update for backup restore
-- ============================================================================
-- Restore from backup (Settings/AdminPanel) upserts into expenses and related
-- tables. Existing policies require auth.uid() = user_id on insert, which fails
-- when restoring rows for other users. These policies allow organization admins
-- to insert/update rows in their org for restore only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. expenses: allow org admin to INSERT (for restore; normal create still
--    requires auth.uid() = user_id via existing policy)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert expenses in their org for restore" ON public.expenses;
CREATE POLICY "Admins can insert expenses in their org for restore"
  ON public.expenses FOR INSERT
  WITH CHECK (
    organization_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ----------------------------------------------------------------------------
-- 2. expense_line_items: allow org admin to INSERT when the expense belongs
--    to their org (for restore)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert line items in their org for restore" ON public.expense_line_items;
CREATE POLICY "Admins can insert line items in their org for restore"
  ON public.expense_line_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om
        ON om.organization_id = e.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
      WHERE e.id = expense_line_items.expense_id
    )
  );

-- ----------------------------------------------------------------------------
-- 3. attachments: allow org admin to INSERT for expenses in their org
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert attachments in their org for restore" ON public.attachments;
CREATE POLICY "Admins can insert attachments in their org for restore"
  ON public.attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om
        ON om.organization_id = e.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
      WHERE e.id = attachments.expense_id
    )
  );

-- ----------------------------------------------------------------------------
-- 4. audit_logs: allow org admin to INSERT when the expense is in their org
--    (audit_logs has expense_id; may not have organization_id in all schemas)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert audit logs in their org for restore" ON public.audit_logs;
CREATE POLICY "Admins can insert audit logs in their org for restore"
  ON public.audit_logs FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om
        ON om.organization_id = e.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
      WHERE e.id = audit_logs.expense_id
    )
  );

-- ----------------------------------------------------------------------------
-- 5. expense_form_field_values: allow org admin to INSERT/UPDATE for their org
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert form field values in their org for restore" ON public.expense_form_field_values;
CREATE POLICY "Admins can insert form field values in their org for restore"
  ON public.expense_form_field_values FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can update form field values in their org for restore" ON public.expense_form_field_values;
CREATE POLICY "Admins can update form field values in their org for restore"
  ON public.expense_form_field_values FOR UPDATE
  USING (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ----------------------------------------------------------------------------
-- 6. profiles: ensure org admin can UPDATE any profile in their org (for
--    restore upsert). Existing "Admins can update any profile" may exist;
--    this one is explicit for restore.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can update profiles in their org for restore" ON public.profiles;
CREATE POLICY "Admins can update profiles in their org for restore"
  ON public.profiles FOR UPDATE
  USING (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ----------------------------------------------------------------------------
-- 7. user_roles: allow org admin to INSERT/UPDATE for users in their org
--    (user_roles has user_id; org comes from organization_memberships)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert user_roles in their org for restore" ON public.user_roles;
CREATE POLICY "Admins can insert user_roles in their org for restore"
  ON public.user_roles FOR INSERT
  WITH CHECK (
    user_id IN (
      SELECT om.user_id FROM public.organization_memberships om
      WHERE om.organization_id IN (
        SELECT o2.organization_id FROM public.organization_memberships o2
        WHERE o2.user_id = auth.uid()
          AND o2.role = 'admin'
          AND o2.is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "Admins can update user_roles in their org for restore" ON public.user_roles;
CREATE POLICY "Admins can update user_roles in their org for restore"
  ON public.user_roles FOR UPDATE
  USING (
    user_id IN (
      SELECT om.user_id FROM public.organization_memberships om
      WHERE om.organization_id IN (
        SELECT o2.organization_id FROM public.organization_memberships o2
        WHERE o2.user_id = auth.uid()
          AND o2.role = 'admin'
          AND o2.is_active = true
      )
    )
  )
  WITH CHECK (
    user_id IN (
      SELECT om.user_id FROM public.organization_memberships om
      WHERE om.organization_id IN (
        SELECT o2.organization_id FROM public.organization_memberships o2
        WHERE o2.user_id = auth.uid()
          AND o2.role = 'admin'
          AND o2.is_active = true
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 8. cash_transfer_history: allow org admin to INSERT for their org
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert cash transfer history in their org for restore" ON public.cash_transfer_history;
CREATE POLICY "Admins can insert cash transfer history in their org for restore"
  ON public.cash_transfer_history FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Admins can update cash transfer history in their org for restore" ON public.cash_transfer_history;
CREATE POLICY "Admins can update cash transfer history in their org for restore"
  ON public.cash_transfer_history FOR UPDATE
  USING (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT om.organization_id FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

-- ----------------------------------------------------------------------------
-- 9. organization_settings: allow org admin to INSERT/UPDATE for their org
--    (table may not exist in all deployments)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'organization_settings') THEN
    DROP POLICY IF EXISTS "Admins can insert organization_settings for restore" ON public.organization_settings;
    CREATE POLICY "Admins can insert organization_settings for restore"
      ON public.organization_settings FOR INSERT
      WITH CHECK (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      );
    DROP POLICY IF EXISTS "Admins can update organization_settings for restore" ON public.organization_settings;
    CREATE POLICY "Admins can update organization_settings for restore"
      ON public.organization_settings FOR UPDATE
      USING (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      )
      WITH CHECK (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      );
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 10. expense_categories: if table has organization_id, allow admin insert/update.
--     If it does not, skip (categories may be global).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'expense_categories' AND column_name = 'organization_id'
  ) THEN
    DROP POLICY IF EXISTS "Admins can insert expense_categories for restore" ON public.expense_categories;
    CREATE POLICY "Admins can insert expense_categories for restore"
      ON public.expense_categories FOR INSERT
      WITH CHECK (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      );
    DROP POLICY IF EXISTS "Admins can update expense_categories for restore" ON public.expense_categories;
    CREATE POLICY "Admins can update expense_categories for restore"
      ON public.expense_categories FOR UPDATE
      USING (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      )
      WITH CHECK (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      );
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 11. locations: if table has organization_id, allow admin insert/update.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'locations' AND column_name = 'organization_id'
  ) THEN
    DROP POLICY IF EXISTS "Admins can insert locations for restore" ON public.locations;
    CREATE POLICY "Admins can insert locations for restore"
      ON public.locations FOR INSERT
      WITH CHECK (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      );
    DROP POLICY IF EXISTS "Admins can update locations for restore" ON public.locations;
    CREATE POLICY "Admins can update locations for restore"
      ON public.locations FOR UPDATE
      USING (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      )
      WITH CHECK (
        organization_id IN (
          SELECT om.organization_id FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.role = 'admin'
            AND om.is_active = true
        )
      );
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 12. engineer_locations: allow org admin to INSERT/UPDATE when the engineer
--     is in their org (engineer_id in organization_memberships).
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert engineer_locations in their org for restore" ON public.engineer_locations;
CREATE POLICY "Admins can insert engineer_locations in their org for restore"
  ON public.engineer_locations FOR INSERT
  WITH CHECK (
    engineer_id IN (
      SELECT om.user_id FROM public.organization_memberships om
      WHERE om.organization_id IN (
        SELECT o2.organization_id FROM public.organization_memberships o2
        WHERE o2.user_id = auth.uid()
          AND o2.role = 'admin'
          AND o2.is_active = true
      )
    )
  );

DROP POLICY IF EXISTS "Admins can update engineer_locations in their org for restore" ON public.engineer_locations;
CREATE POLICY "Admins can update engineer_locations in their org for restore"
  ON public.engineer_locations FOR UPDATE
  USING (
    engineer_id IN (
      SELECT om.user_id FROM public.organization_memberships om
      WHERE om.organization_id IN (
        SELECT o2.organization_id FROM public.organization_memberships o2
        WHERE o2.user_id = auth.uid()
          AND o2.role = 'admin'
          AND o2.is_active = true
      )
    )
  )
  WITH CHECK (
    engineer_id IN (
      SELECT om.user_id FROM public.organization_memberships om
      WHERE om.organization_id IN (
        SELECT o2.organization_id FROM public.organization_memberships o2
        WHERE o2.user_id = auth.uid()
          AND o2.role = 'admin'
          AND o2.is_active = true
      )
    )
  );
