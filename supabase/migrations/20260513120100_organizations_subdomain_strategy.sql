-- Tenant hostname label + strategy FK (requires strategies migration applied first).

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS subdomain text,
  ADD COLUMN IF NOT EXISTS strategy_slug text;

UPDATE public.organizations SET strategy_slug = 'standard' WHERE strategy_slug IS NULL;

ALTER TABLE public.organizations
  ALTER COLUMN strategy_slug SET NOT NULL,
  ALTER COLUMN strategy_slug SET DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_strategy_slug_fkey'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_strategy_slug_fkey
      FOREIGN KEY (strategy_slug) REFERENCES public.strategies (slug);
  END IF;
END $$;

DROP INDEX IF EXISTS idx_organizations_subdomain_lower_unique;
CREATE UNIQUE INDEX idx_organizations_subdomain_lower_unique
  ON public.organizations (lower(trim(subdomain)))
  WHERE subdomain IS NOT NULL AND trim(subdomain) <> '';

COMMENT ON COLUMN public.organizations.subdomain IS 'Hostname label for tenant URL: {subdomain}.{VITE_APP_BASE_DOMAIN}. Null = shared domain only.';
COMMENT ON COLUMN public.organizations.strategy_slug IS 'Product strategy for org-specific branching in app code.';
