-- Create organization-owned source bank accounts for transfer logging

CREATE TABLE IF NOT EXISTS public.organization_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  ifsc_code TEXT NOT NULL,
  branch_name TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_bank_accounts_org
  ON public.organization_bank_accounts (organization_id, is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_org_bank_accounts_org_bank
  ON public.organization_bank_accounts (organization_id, bank_name);

ALTER TABLE public.organization_bank_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members can view bank accounts" ON public.organization_bank_accounts;
CREATE POLICY "Org members can view bank accounts"
  ON public.organization_bank_accounts
  FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid()
        AND is_active = true
        AND role IN ('admin', 'cashier')
    )
  );

DROP POLICY IF EXISTS "Org admins can manage bank accounts" ON public.organization_bank_accounts;
CREATE POLICY "Org admins can manage bank accounts"
  ON public.organization_bank_accounts
  FOR ALL
  USING (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid()
        AND is_active = true
        AND role = 'admin'
    )
  )
  WITH CHECK (
    organization_id IN (
      SELECT organization_id
      FROM public.organization_memberships
      WHERE user_id = auth.uid()
        AND is_active = true
        AND role = 'admin'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'update_organization_bank_accounts_updated_at'
  ) THEN
    CREATE TRIGGER update_organization_bank_accounts_updated_at
      BEFORE UPDATE ON public.organization_bank_accounts
      FOR EACH ROW
      EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

COMMENT ON TABLE public.organization_bank_accounts IS 'Organization source bank accounts used for bank transfer allocations.';
