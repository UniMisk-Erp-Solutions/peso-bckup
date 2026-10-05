-- ============================================================================
-- Historical Balance Anchor V2 — PRE-FLIGHT verification (READ-ONLY)
-- ============================================================================
-- Run this BEFORE applying supabase/migrations/20260824100000 through
-- 20260824140000 to confirm the environment's current state matches what
-- those migrations assume. Safe to run against Production at any time --
-- every statement in this file is a SELECT. It contains NO UPDATE, INSERT,
-- DELETE, ALTER, CREATE, DROP, or CREATE OR REPLACE.
--
-- Usage: psql -f verify_historical_balance_v2_rollout.sql, or paste into the
-- Supabase SQL editor. Read the `present`/`expected_true` columns; a FALSE
-- where TRUE is expected (or vice versa) means the environment does not
-- match this branch's assumptions and applying the migrations needs a closer
-- look first.
--
-- See RELEASE-PREP §16/§24 and Documentations MD/historical-balance-anchors-v2.md.
-- ============================================================================

-- 1. Required base tables already exist (these migrations only ALTER/extend
--    them, never create them).
SELECT 'base_table_present' AS check_type, t.expected AS name,
       EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = t.expected
       ) AS present
FROM (VALUES
  ('balance_ledger'), ('balance_import_batches'), ('balance_import_rows'),
  ('profiles'), ('organization_memberships'), ('expense_balance_deductions'),
  ('balance_transfer_offers')
) AS t(expected);

-- 2. The anchor table must NOT already exist -- if it does, migration 1000
--    (or an equivalent) has already run on this environment.
SELECT 'anchor_table_not_yet_present' AS check_type,
       'balance_historical_anchors' AS name,
       NOT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'balance_historical_anchors'
       ) AS expected_true;

-- 3. V1 import RPCs currently exist -- old frontend must keep working
--    through Phase B/C of the rollout.
SELECT 'v1_import_rpc_present' AS check_type, p.expected AS name,
       EXISTS (
         SELECT 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
         WHERE pr.proname = p.expected AND n.nspname = 'public'
       ) AS present
FROM (VALUES ('balance_validate_import_v1'), ('balance_apply_import_v1')) AS p(expected);

-- 4. None of the new V2 RPCs (migrations 1000-1300, plus the capability
--    probe) should exist yet on a truly pre-rollout environment.
SELECT 'v2_rpc_not_yet_present' AS check_type, p.expected AS name,
       NOT EXISTS (
         SELECT 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
         WHERE pr.proname = p.expected AND n.nspname = 'public'
       ) AS expected_true
FROM (VALUES
  ('balance_validate_import_v2'), ('balance_apply_import_v2'),
  ('balance_preview_historical_anchor_v1'), ('balance_apply_historical_anchor_v1'),
  ('balance_reverse_historical_anchor_v1'), ('get_balance_historical_anchors_v1'),
  ('get_my_unified_balance_history_v2'), ('get_org_balance_ledger_v2'),
  ('balance_historical_v2_capabilities_v1')
) AS p(expected);

-- 5. Legacy (pre-v2) transfer-offer RPCs currently exist and their grants --
--    confirms the exact exposure migration 1400 will eventually close.
SELECT 'legacy_transfer_rpc_grants' AS check_type,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('propose_balance_transfer_offer', 'accept_balance_transfer_offer');

-- 6. V2 transfer-offer RPCs currently exist (frontend already calls these
--    exclusively for propose/accept -- see BalanceTransferOfferService.ts).
SELECT 'v2_transfer_rpc_present' AS check_type, p.expected AS name,
       EXISTS (
         SELECT 1 FROM pg_proc pr JOIN pg_namespace n ON n.oid = pr.pronamespace
         WHERE pr.proname = p.expected AND n.nspname = 'public'
       ) AS present
FROM (VALUES ('propose_balance_transfer_offer_v2'), ('accept_balance_transfer_offer_v2')) AS p(expected);

-- 7. Current balance_ledger CHECK constraint definitions -- confirms the
--    exact starting list migration 1000 will DROP and re-ADD as a superset
--    (this is exactly the check that caught the 'money_return' regression
--    during this branch's static review; re-run this before ever applying
--    1000 again on any environment).
SELECT 'current_constraint_definition' AS check_type, con.conname AS name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'balance_ledger'
  AND con.contype = 'c'
  AND con.conname IN ('balance_ledger_source_type_check', 'balance_ledger_entry_type_check');

-- 8. Current balance_import_batches / balance_import_rows CHECK constraints.
SELECT 'current_constraint_definition' AS check_type, con.conname AS name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname IN ('balance_import_batches', 'balance_import_rows')
  AND con.contype = 'c';

-- 9. Informational row counts -- flags an unexpectedly large table before a
--    schema change that re-validates every row (ADD CONSTRAINT).
SELECT 'row_count' AS check_type, 'balance_ledger' AS name, count(*)::text AS value FROM public.balance_ledger
UNION ALL
SELECT 'row_count', 'balance_import_batches', count(*)::text FROM public.balance_import_batches
UNION ALL
SELECT 'row_count', 'balance_transfer_offers', count(*)::text FROM public.balance_transfer_offers;
