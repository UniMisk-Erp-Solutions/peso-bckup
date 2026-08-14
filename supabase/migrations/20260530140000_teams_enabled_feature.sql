-- Feature key: teams_enabled (org structure, My Teams dashboard, team exports).
-- Decoupled from approval_hierarchy (multi-tier routing).
-- Master Admin enables per org via organization_features; no auto-enable here.
--
-- Rollout: orgs with approval_hierarchy ON should also enable teams_enabled
-- so Settings → Teams remains available after deploy.

COMMENT ON TABLE public.organization_features IS
  'Feature flags per organization. Keys include teams_enabled, approval_hierarchy — see src/lib/organizationFeatureKeys.ts';
