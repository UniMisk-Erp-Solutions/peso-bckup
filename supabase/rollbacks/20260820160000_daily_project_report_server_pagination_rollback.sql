-- DOC-101 — rollback for 20260820160000_daily_project_report_server_pagination.sql
--
-- The forward migration is purely additive: it creates five new functions and
-- one new index and modifies nothing that already existed. Dropping them
-- therefore restores the previous database state exactly.
--
-- ORDER MATTERS: get_daily_project_report_page_v1 calls the four helpers, so it
-- goes first.
--
-- CLIENT IMPACT: after this runs, the Reports → Daily Project Report tab will
-- fail with "The report could not be completed…" until the frontend is also
-- rolled back to a build that still uses the legacy
-- fetchDailyProjectExpenseReportRows path. Roll the frontend back FIRST, or
-- accept a visibly broken (never silently partial) report tab in between.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.get_daily_project_report_page_v1(
  uuid, date, date, uuid, uuid[], boolean, timestamptz, jsonb, integer
);

DROP FUNCTION IF EXISTS public.daily_report_caller_can_view_v1(uuid, boolean);

DROP FUNCTION IF EXISTS public._daily_report_base_value_v1(
  text, text, text, text, text, date, numeric
);

DROP FUNCTION IF EXISTS public._daily_report_parse_source_v1(text);

DROP FUNCTION IF EXISTS public.daily_report_cost_column_v1(text, jsonb);

DROP INDEX IF EXISTS public.expenses_daily_report_scope_idx;
