-- ============================================================================
-- RLS: Allow org admins to UPSERT attachments (and related rows) during backup
-- restore. Restore uses ON CONFLICT DO UPDATE; without UPDATE policies Postgres
-- rejects existing rows with "violates row-level security policy (USING
-- expression)" even when INSERT policies exist.
-- ============================================================================

-- Org admins can SELECT attachments for expenses in their org (upsert + admin UI)
DROP POLICY IF EXISTS "Org admins can view organization attachments" ON public.attachments;
CREATE POLICY "Org admins can view organization attachments"
  ON public.attachments FOR SELECT
  USING (
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

-- Re-ensure INSERT policy (idempotent; may be missing on some deployments)
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

DROP POLICY IF EXISTS "Admins can update attachments in their org for restore" ON public.attachments;
CREATE POLICY "Admins can update attachments in their org for restore"
  ON public.attachments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om
        ON om.organization_id = e.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
      WHERE e.id = attachments.expense_id
    )
  )
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

-- expense_line_items: restore upsert may update existing rows
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

DROP POLICY IF EXISTS "Admins can update line items in their org for restore" ON public.expense_line_items;
CREATE POLICY "Admins can update line items in their org for restore"
  ON public.expense_line_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om
        ON om.organization_id = e.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
      WHERE e.id = expense_line_items.expense_id
    )
  )
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

-- audit_logs: restore upsert may update existing rows
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

DROP POLICY IF EXISTS "Admins can update audit logs in their org for restore" ON public.audit_logs;
CREATE POLICY "Admins can update audit logs in their org for restore"
  ON public.audit_logs FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      INNER JOIN public.organization_memberships om
        ON om.organization_id = e.organization_id
        AND om.user_id = auth.uid()
        AND om.role = 'admin'
        AND om.is_active = true
      WHERE e.id = audit_logs.expense_id
    )
  )
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
