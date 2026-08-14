-- One-time setup for MS org tenant: ms.pesowise.unimisk.com
-- Org id: e0e9c7a9-555f-448a-8ba2-10fae8e0bf64
-- Run in Supabase SQL Editor (production project) after tenant migrations are applied.

UPDATE public.organizations
SET subdomain = 'ms'
WHERE id = 'e0e9c7a9-555f-448a-8ba2-10fae8e0bf64';

INSERT INTO public.organization_features (organization_id, feature_key, enabled, updated_at)
VALUES (
  'e0e9c7a9-555f-448a-8ba2-10fae8e0bf64',
  'employee_id_login',
  true,
  now()
)
ON CONFLICT (organization_id, feature_key)
DO UPDATE SET enabled = true, updated_at = now();

-- Verify (should return one row with subdomain ms)
SELECT id, name, slug, subdomain
FROM public.organizations
WHERE id = 'e0e9c7a9-555f-448a-8ba2-10fae8e0bf64';

SELECT feature_key, enabled
FROM public.organization_features
WHERE organization_id = 'e0e9c7a9-555f-448a-8ba2-10fae8e0bf64'
  AND feature_key = 'employee_id_login';

-- Each employee user needs profiles.employee_id set (unique per org) and is_active = true.
