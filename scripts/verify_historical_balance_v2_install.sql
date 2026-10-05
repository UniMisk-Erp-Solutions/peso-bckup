-- ============================================================================
-- Historical Balance Anchor V2 — POST-INSTALL verification (READ-ONLY)
-- ============================================================================
-- Run this AFTER applying supabase/migrations/20260824100000 through
-- 20260824130000 (schema, engine, import v2, history v2) -- BEFORE applying
-- 20260824140000 (the legacy transfer-offer RPC revoke). Confirms exactly
-- what got installed matches expectations. Safe to run against Production at
-- any time -- every statement in this file is a SELECT. It contains NO
-- UPDATE, INSERT, DELETE, ALTER, CREATE, DROP, or CREATE OR REPLACE, and it
-- does not require any anchor rows to exist -- an empty
-- balance_historical_anchors table is a fully valid, fully-installed state
-- (every check here is schema/grant-level, never data-level).
--
-- See RELEASE-PREP §16/§25 and Documentations MD/historical-balance-anchors-v2.md.
-- ============================================================================

-- 1. Anchor table exists.
SELECT 'table_exists' AS check_type, 'balance_historical_anchors' AS name,
       EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'balance_historical_anchors'
       ) AS present;

-- 2. RLS is enabled on the anchor table.
SELECT 'rls_enabled' AS check_type, 'balance_historical_anchors' AS name,
       relrowsecurity AS enabled
FROM pg_class
WHERE relname = 'balance_historical_anchors' AND relnamespace = 'public'::regnamespace;

-- 3. Every expected index exists.
SELECT 'index_exists' AS check_type, i.expected AS name,
       EXISTS (
         SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = i.expected
       ) AS present
FROM (VALUES
  ('balance_historical_anchors_active_revision_uidx'),
  ('balance_historical_anchors_one_active_opening_uidx'),
  ('balance_historical_anchors_timeline_idx'),
  ('balance_historical_anchors_sequence_lookup_idx'),
  ('balance_historical_anchors_revision_group_idx'),
  ('balance_historical_anchors_source_batch_idx')
) AS i(expected);

-- 4. New balance_import_rows columns (conflict/resolution tracking) exist.
SELECT 'column_exists' AS check_type, 'balance_import_rows.' || c.expected AS name,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'balance_import_rows' AND column_name = c.expected
       ) AS present
FROM (VALUES
  ('conflict_status'), ('conflict_type'), ('resolution_action'), ('resolution_target_anchor_id'),
  ('resolution_reason'), ('resolution_override_balance'), ('resolution_override_effective_date'),
  ('resolution_override_note'), ('resulting_anchor_id'), ('historical_position_before')
) AS c(expected);

-- 5. Internal (_-prefixed) engine functions are NOT executable by anon or
--    authenticated -- they must only ever run as an implementation detail of
--    a public SECURITY DEFINER RPC, never called directly by a client.
SELECT 'internal_function_locked_down' AS check_type,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
       NOT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_denied,
       NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_denied
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    '_balance_historical_position_before_v1', '_balance_materialize_anchor_v1',
    '_balance_cascade_downstream_anchors_v1', '_balance_next_anchor_sequence_v1',
    '_balance_apply_historical_anchor_core_v1'
  );
-- Expected: anon_denied = true AND authenticated_denied = true for every row.

-- 6. Public anchor/import/history/capability RPCs: authenticated CAN
--    execute, anon CANNOT.
SELECT 'public_rpc_grants' AS check_type,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'balance_validate_import_v2', 'balance_apply_import_v2',
    'balance_preview_historical_anchor_v1', 'balance_apply_historical_anchor_v1',
    'balance_reverse_historical_anchor_v1', 'get_balance_historical_anchors_v1',
    'get_my_unified_balance_history_v2', 'get_org_balance_ledger_v2',
    'balance_historical_v2_capabilities_v1'
  );
-- Expected: authenticated_can_execute = true AND anon_can_execute = false for every row.

-- 7. V1 import RPCs are still present -- the compatibility window: old
--    frontend keeps working until it is deployed onto V2.
SELECT 'v1_import_still_present' AS check_type, p.expected AS name,
       EXISTS (
         SELECT 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
         WHERE pr.proname = p.expected AND n.nspname = 'public'
       ) AS present
FROM (VALUES ('balance_validate_import_v1'), ('balance_apply_import_v1')) AS p(expected);

-- 8. Legacy transfer-offer v1 RPCs are still present AND still granted --
--    migration 1400 has NOT been applied yet at this point in the rollout.
SELECT 'legacy_transfer_v1_not_yet_revoked' AS check_type,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('propose_balance_transfer_offer', 'accept_balance_transfer_offer');

-- 9. V2 transfer-offer RPCs are present.
SELECT 'v2_transfer_present' AS check_type, p.expected AS name,
       EXISTS (
         SELECT 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
         WHERE pr.proname = p.expected AND n.nspname = 'public'
       ) AS present
FROM (VALUES ('propose_balance_transfer_offer_v2'), ('accept_balance_transfer_offer_v2')) AS p(expected);

-- 10. The capability probe itself -- the single source of truth the
--     frontend actually reads -- reports ready=true. If every check above
--     passed but this reports false, the frontend gate and this script have
--     diverged and the probe function's own logic needs re-review before
--     trusting anything else here.
SELECT 'capability_probe_reports_ready' AS check_type,
       'balance_historical_v2_capabilities_v1()' AS name,
       (public.balance_historical_v2_capabilities_v1() ->> 'ready')::boolean AS ready;

-- 11. Sanity: no anchor rows are required for a fully-installed state.
SELECT 'no_data_required' AS check_type, 'balance_historical_anchors' AS name,
       count(*)::text AS current_row_count
FROM public.balance_historical_anchors;
