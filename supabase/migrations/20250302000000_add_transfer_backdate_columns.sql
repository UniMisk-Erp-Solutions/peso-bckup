-- Add columns to cash_transfer_history for admin backdating of transfer dates.
-- Original date is preserved; edit metadata and flag support audit and reporting.

-- Original transfer date (set on first edit; null until then)
ALTER TABLE public.cash_transfer_history
  ADD COLUMN IF NOT EXISTS transferred_at_original TIMESTAMPTZ;

-- When the date was edited (by admin)
ALTER TABLE public.cash_transfer_history
  ADD COLUMN IF NOT EXISTS transferred_at_edited_at TIMESTAMPTZ;

-- Admin who edited the date
ALTER TABLE public.cash_transfer_history
  ADD COLUMN IF NOT EXISTS transferred_at_edited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Flag for filtering/reporting (true when date was ever backdated)
ALTER TABLE public.cash_transfer_history
  ADD COLUMN IF NOT EXISTS date_edited BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.cash_transfer_history.transferred_at_original IS 'Original transfer date before admin backdate; set on first edit.';
COMMENT ON COLUMN public.cash_transfer_history.transferred_at_edited_at IS 'When the transfer date was last edited by an admin.';
COMMENT ON COLUMN public.cash_transfer_history.transferred_at_edited_by IS 'Admin user_id who last edited the transfer date.';
COMMENT ON COLUMN public.cash_transfer_history.date_edited IS 'True if this transfer date was edited (backdated) by an admin.';

-- Allow admins to UPDATE rows in their organization (for backdating only; app restricts to date/audit columns)
CREATE POLICY "Admins can update transfers in their organization"
  ON public.cash_transfer_history FOR UPDATE
  USING (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships
      WHERE user_id = auth.uid()
        AND organization_id = cash_transfer_history.organization_id
        AND role = 'admin'
        AND is_active = true
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid() AND is_active = true
    )
  );
