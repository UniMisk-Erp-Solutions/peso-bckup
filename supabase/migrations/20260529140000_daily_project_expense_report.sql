-- Daily project expense report: org config JSON + optional feature row seed (master admin toggles via UI)
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS daily_expense_report_config JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.organization_settings.daily_expense_report_config IS
  'Admin mapping: custom field template IDs for project/location + expense category → cost column buckets for daily project report export.';
