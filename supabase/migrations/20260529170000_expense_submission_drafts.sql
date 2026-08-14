-- Safety copies of submitted expenses (7-day retention).
-- Written on every successful submit (and attachment-failure draft save) so data survives main row loss.

CREATE TABLE IF NOT EXISTS public.expense_submission_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  source_expense_id uuid REFERENCES public.expenses (id) ON DELETE SET NULL,
  submission_status text NOT NULL DEFAULT 'submitted'
    CHECK (submission_status IN ('submitted', 'draft')),
  title text,
  destination text,
  trip_start date,
  total_amount numeric(12, 2),
  category text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_submission_drafts_user_org_created
  ON public.expense_submission_drafts (user_id, organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expense_submission_drafts_expires
  ON public.expense_submission_drafts (expires_at)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_expense_submission_drafts_source_expense
  ON public.expense_submission_drafts (source_expense_id)
  WHERE source_expense_id IS NOT NULL;

COMMENT ON TABLE public.expense_submission_drafts IS
  '7-day safety snapshot when an employee submits an expense. Independent of expenses.status draft; used for disaster recovery.';

ALTER TABLE public.expense_submission_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users select own submission drafts" ON public.expense_submission_drafts;
CREATE POLICY "Users select own submission drafts"
  ON public.expense_submission_drafts FOR SELECT
  USING (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_submission_drafts.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Users insert own submission drafts" ON public.expense_submission_drafts;
CREATE POLICY "Users insert own submission drafts"
  ON public.expense_submission_drafts FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_submission_drafts.organization_id
        AND om.is_active = true
    )
  );

DROP POLICY IF EXISTS "Users update own submission drafts" ON public.expense_submission_drafts;
CREATE POLICY "Users update own submission drafts"
  ON public.expense_submission_drafts FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Org admins select submission drafts in org" ON public.expense_submission_drafts;
CREATE POLICY "Org admins select submission drafts in org"
  ON public.expense_submission_drafts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND om.organization_id = expense_submission_drafts.organization_id
        AND om.role = 'admin'
        AND om.is_active = true
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.expense_submission_drafts TO authenticated;
GRANT ALL ON public.expense_submission_drafts TO service_role;
