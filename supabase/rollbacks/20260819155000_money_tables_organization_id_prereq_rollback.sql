-- Rollback for 20260819155000_money_tables_organization_id_prereq.sql
--
-- WARNING: only safe once every imported balance migration that writes these
-- columns has itself been rolled back. Dropping them while
-- balance_add_funds_v1 / approve_money_return_request_v2 are still installed
-- reintroduces the exact runtime failure the prerequisite exists to prevent.

DROP INDEX IF EXISTS public.idx_money_return_requests_org;
ALTER TABLE public.money_return_requests DROP COLUMN IF EXISTS organization_id;

DROP INDEX IF EXISTS public.idx_money_assignments_org;
ALTER TABLE public.money_assignments DROP COLUMN IF EXISTS organization_id;

NOTIFY pgrst, 'reload schema';
