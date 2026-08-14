-- Speed up dashboard aggregate RPCs on large orgs (self-hosted statement timeouts).

CREATE INDEX IF NOT EXISTS idx_expenses_organization_id
  ON public.expenses (organization_id);

CREATE INDEX IF NOT EXISTS idx_expenses_user_id
  ON public.expenses (user_id);

CREATE INDEX IF NOT EXISTS idx_expenses_org_status
  ON public.expenses (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_expenses_assigned_engineer_status
  ON public.expenses (assigned_engineer_id, status)
  WHERE assigned_engineer_id IS NOT NULL;
