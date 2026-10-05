-- Hardening follow-up to 20260923000000_expense_field_recent_values_v1.sql.
--
-- A database-level default-privileges rule (ALTER DEFAULT PRIVILEGES FOR ROLE
-- postgres IN SCHEMA public GRANT ... TO anon) silently granted anon full
-- table privileges on expense_field_recent_values and raw EXECUTE on all
-- three new RPCs the instant they were created -- REVOKE ... FROM PUBLIC does
-- not touch a privilege granted directly to a named role. This is the same
-- class of gap DOC-100 found and fixed for 11 other RPCs; it is NOT specific
-- to this feature's own SQL, and was confirmed present here empirically (a
-- rolled-back anon-role probe: SELECT returned 0 rows via RLS, direct INSERT
-- was rejected by RLS with no matching policy, and both RPCs raised "Not
-- authenticated" from their own auth.uid() IS NULL checks) -- so nothing was
-- ever actually exploitable, but the raw grant itself should not exist.
--
-- This migration only removes anon's access; it does not change any
-- behavior for authenticated users or service_role.

REVOKE ALL ON public.expense_field_recent_values FROM anon;
REVOKE ALL ON FUNCTION public.get_recent_expense_field_values_v1(uuid, text[]) FROM anon;
REVOKE ALL ON FUNCTION public.record_recent_expense_field_values_v1(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.bootstrap_expense_field_memory_v1(uuid) FROM anon;

DO $verify$
DECLARE
  v_table_priv boolean;
  v_read_exec boolean;
  v_write_exec boolean;
  v_bootstrap_exec boolean;
BEGIN
  SELECT has_table_privilege('anon', 'public.expense_field_recent_values', 'SELECT')
    INTO v_table_priv;
  SELECT has_function_privilege('anon', 'public.get_recent_expense_field_values_v1(uuid, text[])', 'EXECUTE')
    INTO v_read_exec;
  SELECT has_function_privilege('anon', 'public.record_recent_expense_field_values_v1(uuid)', 'EXECUTE')
    INTO v_write_exec;
  SELECT has_function_privilege('anon', 'public.bootstrap_expense_field_memory_v1(uuid)', 'EXECUTE')
    INTO v_bootstrap_exec;

  IF v_table_priv OR v_read_exec OR v_write_exec OR v_bootstrap_exec THEN
    RAISE EXCEPTION 'anon still has access after revoke: table=%, read_rpc=%, write_rpc=%, bootstrap_rpc=%',
      v_table_priv, v_read_exec, v_write_exec, v_bootstrap_exec;
  END IF;

  RAISE NOTICE 'expense_field_memory_revoke_anon verified OK -- anon has zero access to all 4 objects';
END;
$verify$;
