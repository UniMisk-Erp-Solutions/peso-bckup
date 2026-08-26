-- Rollback for 20260819162000_balance_import_schema.sql
-- Safe only if no dependent migration (163000+) has been applied.
DROP TABLE IF EXISTS public.balance_import_rows CASCADE;
DROP TABLE IF EXISTS public.balance_import_batches CASCADE;
DROP TABLE IF EXISTS public.balance_import_mapping_profiles CASCADE;
