-- Rollback for 20260827100000_daily_report_source_expense_purpose.sql
--
-- Restores get_daily_project_report_page_v1 to its
-- 20260826100000_daily_report_dynamic_project_name.sql body (source_expenses
-- without 'purpose'). Re-run that migration's CREATE OR REPLACE block to
-- fully revert -- not repeated here for length, since it is byte-identical
-- except for the one removed jsonb key.

NOTIFY pgrst, 'reload schema';
