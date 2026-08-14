-- Org setting: require immediate supervisor for employee / team_leader / executive.

ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS require_immediate_supervisor boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organization_settings.require_immediate_supervisor IS
  'When true, users with roles employee, team_leader, or executive must have profiles.reporting_engineer_id set.';
