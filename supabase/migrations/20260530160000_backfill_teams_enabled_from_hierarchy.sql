-- Orgs that already use approval_hierarchy should get teams_enabled ON so
-- Settings → Teams and My Teams stay available after the flag split.
INSERT INTO public.organization_features (organization_id, feature_key, enabled, updated_at)
SELECT
  ofe.organization_id,
  'teams_enabled',
  true,
  now()
FROM public.organization_features ofe
WHERE ofe.feature_key = 'approval_hierarchy'
  AND ofe.enabled = true
ON CONFLICT (organization_id, feature_key)
DO UPDATE SET
  enabled = EXCLUDED.enabled,
  updated_at = EXCLUDED.updated_at;
