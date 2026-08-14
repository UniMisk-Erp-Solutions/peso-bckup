-- Batch expense entry: grouping table, expenses.batch_id, org receipt mode setting.

CREATE TABLE IF NOT EXISTS public.expense_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  label text,
  shared_category text NOT NULL,
  shared_expense_date date NOT NULL,
  line_count integer NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_batches_org_created
  ON public.expense_batches (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expense_batches_user
  ON public.expense_batches (user_id, created_at DESC);

COMMENT ON TABLE public.expense_batches IS
  'Groups multiple expenses submitted together via batch entry wizard.';

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.expense_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_batch_id ON public.expenses (batch_id)
  WHERE batch_id IS NOT NULL;

ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS batch_expense_attachment_mode text NOT NULL DEFAULT 'per_line';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'organization_settings_batch_expense_attachment_mode_check'
  ) THEN
    ALTER TABLE public.organization_settings
      ADD CONSTRAINT organization_settings_batch_expense_attachment_mode_check
      CHECK (batch_expense_attachment_mode IN ('per_line', 'shared'));
  END IF;
END $$;

COMMENT ON COLUMN public.organization_settings.batch_expense_attachment_mode IS
  'per_line: each batch line over receipt threshold needs its own upload; shared: one receipt for the whole batch.';

ALTER TABLE public.expense_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own expense batches" ON public.expense_batches;
CREATE POLICY "Users can view own expense batches"
  ON public.expense_batches FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_batches.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM public.expenses ex
      WHERE ex.batch_id = expense_batches.id
        AND ex.assigned_engineer_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users can insert own expense batches" ON public.expense_batches;
CREATE POLICY "Users can insert own expense batches"
  ON public.expense_batches FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_batches.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Users can update own expense batches" ON public.expense_batches;
CREATE POLICY "Users can update own expense batches"
  ON public.expense_batches FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
