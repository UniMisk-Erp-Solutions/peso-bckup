-- Daily project expense report: org mapping config column
-- Run in Supabase SQL Editor after deploy, then Settings → API → Reload schema.

ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS daily_expense_report_config JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.organization_settings.daily_expense_report_config IS
  'Admin mapping: base/custom field sources for project/location + category → cost column buckets for daily project report export.';
