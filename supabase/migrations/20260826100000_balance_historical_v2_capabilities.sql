-- DOC-080-pattern capability probe (additive, read-only) — Historical Balance
-- Anchors V2 / Bulk Balance Import V2.
--
-- A tiny discovery RPC the frontend calls at runtime to learn whether the
-- Historical Balance Anchor V2 backend (migrations 20260824100000 through
-- 20260824130000, plus 20260826110000's atomic import reversal) is actually
-- installed on the environment it's running against. Mirrors the existing
-- review_manager_override_capabilities_v1 /
-- debug_review_queue_capabilities_v1 idiom exactly: report {contract,
-- version, ready, functions} computed from pg_proc/pg_namespace existence
-- checks, never guess, never mutate.
--
-- CRITICAL: this migration itself has NOT been applied wherever the V2
-- anchor migrations haven't been applied either -- calling this RPC before
-- ANY of it exists still 404s (PGRST202). The frontend capability wrapper
-- fails closed on that exact error (same as every other consumer of this
-- idiom in the codebase), so deployment order between this file and
-- 20260824100000-20260824130000 does not matter for correctness, only for
-- how early the UI can show "backend update required" instead of a raw
-- fetch error.
--
-- Performs NO mutation, exposes NO sensitive data, no organization
-- parameter (function existence is a schema-wide fact, not a per-org one).
-- Executable by authenticated; denied to anon/public.

CREATE OR REPLACE FUNCTION public.balance_historical_v2_capabilities_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_validate_import   boolean;
  v_apply_import      boolean;
  v_preview_anchor    boolean;
  v_apply_anchor      boolean;
  v_reverse_anchor    boolean;
  v_get_anchors       boolean;
  v_get_history       boolean;
  v_get_ledger        boolean;
  v_reverse_import    boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'balance_validate_import_v2' AND n.nspname = 'public') INTO v_validate_import;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'balance_apply_import_v2' AND n.nspname = 'public') INTO v_apply_import;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'balance_preview_historical_anchor_v1' AND n.nspname = 'public') INTO v_preview_anchor;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'balance_apply_historical_anchor_v1' AND n.nspname = 'public') INTO v_apply_anchor;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'balance_reverse_historical_anchor_v1' AND n.nspname = 'public') INTO v_reverse_anchor;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'get_balance_historical_anchors_v1' AND n.nspname = 'public') INTO v_get_anchors;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'get_my_unified_balance_history_v2' AND n.nspname = 'public') INTO v_get_history;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'get_org_balance_ledger_v2' AND n.nspname = 'public') INTO v_get_ledger;
  SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'balance_reverse_import_v2' AND n.nspname = 'public') INTO v_reverse_import;

  RETURN jsonb_build_object(
    'contract', 'balance-historical-v2',
    'version', 1,
    'ready',
      v_validate_import AND v_apply_import AND v_preview_anchor AND v_apply_anchor
      AND v_reverse_anchor AND v_get_anchors AND v_get_history AND v_get_ledger AND v_reverse_import,
    'functions', jsonb_build_object(
      'balance_validate_import_v2',          v_validate_import,
      'balance_apply_import_v2',             v_apply_import,
      'balance_preview_historical_anchor_v1', v_preview_anchor,
      'balance_apply_historical_anchor_v1',  v_apply_anchor,
      'balance_reverse_historical_anchor_v1', v_reverse_anchor,
      'get_balance_historical_anchors_v1',   v_get_anchors,
      'get_my_unified_balance_history_v2',   v_get_history,
      'get_org_balance_ledger_v2',           v_get_ledger,
      'balance_reverse_import_v2',           v_reverse_import
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.balance_historical_v2_capabilities_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.balance_historical_v2_capabilities_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.balance_historical_v2_capabilities_v1() TO authenticated;

COMMENT ON FUNCTION public.balance_historical_v2_capabilities_v1() IS
  'Read-only capability probe: returns {contract, version, ready, functions} '
  'where ready is true only when every Historical Balance Anchor V2 RPC '
  '(import validate/apply v2, anchor preview/apply/reverse v1, anchor/history '
  'reads v1/v2, atomic import reverse v2) is installed. The frontend gates '
  'the ACTUAL MUTATION RPCs for Opening Balance/Balance Update/Tally on '
  'this -- never whether those modes are OFFERED in the UI -- and fails '
  'closed (never falls back to the v1 import RPCs) wherever it is not '
  'ready. No mutation, no sensitive data, no organization parameter.';

NOTIFY pgrst, 'reload schema';
