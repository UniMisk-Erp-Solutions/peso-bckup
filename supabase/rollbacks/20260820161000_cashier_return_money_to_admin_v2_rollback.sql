-- Rollback for 20260820161000_cashier_return_money_to_admin_v2.sql
-- (originally authored as 20260820160000; renamed 2026-08-24 during the
--  main-merge reconciliation to resolve a version collision with main's
--  20260820160000_daily_project_report_server_pagination.sql. Neither
--  filename was ever recorded in supabase_migrations.schema_migrations
--  on Production -- both objects were applied via direct SSH psql exec --
--  so this rename has no live-database effect.)
DROP FUNCTION IF EXISTS public.cashier_return_money_to_admin_v2(uuid, numeric, text);
NOTIFY pgrst, 'reload schema';
