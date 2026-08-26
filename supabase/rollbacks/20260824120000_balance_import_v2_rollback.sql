-- Rollback for 20260824120000_balance_import_v2.sql
BEGIN;

DROP FUNCTION IF EXISTS public.balance_apply_import_v2(uuid, jsonb);
DROP FUNCTION IF EXISTS public.balance_validate_import_v2(uuid);

COMMIT;

NOTIFY pgrst, 'reload schema';
