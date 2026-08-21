-- DOC-103 ROLLBACK — remove server-side generated report snapshots.
--
-- DESTRUCTIVE: drops both tables and every stored snapshot with them.
-- If the snapshots matter, export them before running this:
--   \copy (SELECT * FROM public.generated_reports) TO 'generated_reports.csv' CSV HEADER
--
-- Unschedule the retention job first if it was ever created:
--   SELECT cron.unschedule('purge-generated-reports');

DROP FUNCTION IF EXISTS public.purge_expired_generated_report_snapshots_v1();
DROP FUNCTION IF EXISTS public.get_generated_report_v1(uuid);
DROP FUNCTION IF EXISTS public.list_generated_reports_v1(uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.save_generated_report_v1(uuid, text, text, jsonb, jsonb, integer, timestamptz, integer);

DROP POLICY IF EXISTS "Org admins read generated report runs" ON public.generated_report_runs;
DROP POLICY IF EXISTS "Org admins read generated reports"     ON public.generated_reports;

-- runs first: it holds the FK to generated_reports.
DROP TABLE IF EXISTS public.generated_report_runs;
DROP TABLE IF EXISTS public.generated_reports;
