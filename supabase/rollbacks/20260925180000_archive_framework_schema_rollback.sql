-- Rollback archive framework schema (run only after explicit approval)
BEGIN;
DROP SCHEMA IF EXISTS archive CASCADE;
COMMIT;
