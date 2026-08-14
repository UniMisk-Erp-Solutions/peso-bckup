-- ===========================================================================
-- 04 — Reviewer scope: existing Production state diagnostics  (DOC-074)
--
-- SELECT-ONLY. Nothing here writes, creates, drops or alters anything.
-- Run this BEFORE applying 20260731090000_reviewer_visible_expenses_scope.sql
-- so you know exactly what already exists.
--
-- Context: migration 20260730_1200_manager_review_complete_pagination.sql may
-- have (a) never run, (b) run partially — creating the count function and then
-- failing on the list function, or (c) been pasted into the SQL editor by hand
-- with no migration-history row. Each case looks different below.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Migration history rows
--    NOTE: the 2026-07-30 filename has no 14-digit prefix, so the Supabase CLI
--    ignores it and it will NOT appear here even if its SQL was run manually.
-- ---------------------------------------------------------------------------
SELECT
  'migration_history' AS check_name,
  version,
  name
FROM supabase_migrations.schema_migrations
WHERE version LIKE '2026073%'
   OR name ILIKE '%review%pagination%'
   OR name ILIKE '%reviewer_visible%'
ORDER BY version;

-- ---------------------------------------------------------------------------
-- 2. Do the functions exist, and with what signature / return type?
--    Expect 3 rows after the new migration is applied.
-- ---------------------------------------------------------------------------
SELECT
  'function_state' AS check_name,
  n.nspname                                   AS schema,
  p.proname                                   AS function_name,
  pg_get_function_identity_arguments(p.oid)   AS arguments,
  pg_get_function_result(p.oid)               AS return_type,
  p.prosecdef                                 AS is_security_definer,
  p.provolatile                               AS volatility,   -- 's' = STABLE
  p.proconfig                                 AS config        -- expect search_path=public
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'reviewer_visible_user_ids',
    'count_reviewer_visible_expenses',
    'list_reviewer_visible_expenses_page',
    'count_manager_visible_review_expenses',
    'list_manager_visible_review_expenses_page',
    'list_hierarchy_reviewer_expenses'
  )
ORDER BY p.proname;

-- ---------------------------------------------------------------------------
-- 3. Execute privileges — PUBLIC must NOT be able to execute these.
-- ---------------------------------------------------------------------------
SELECT
  'function_grants' AS check_name,
  p.proname         AS function_name,
  COALESCE(a.grantee, '(none)') AS grantee,
  a.privilege_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN LATERAL aclexplode(p.proacl) AS acl ON TRUE
LEFT JOIN LATERAL (
  SELECT
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
    acl.privilege_type
) a ON TRUE
WHERE n.nspname = 'public'
  AND p.proname IN (
    'reviewer_visible_user_ids',
    'count_reviewer_visible_expenses',
    'list_reviewer_visible_expenses_page'
  )
ORDER BY p.proname, a.grantee;

-- ---------------------------------------------------------------------------
-- 4. Full current definitions (useful when a partial/manual apply is suspected)
-- ---------------------------------------------------------------------------
SELECT
  'function_definition' AS check_name,
  p.proname             AS function_name,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'reviewer_visible_user_ids',
    'count_reviewer_visible_expenses',
    'list_reviewer_visible_expenses_page',
    'count_manager_visible_review_expenses',
    'list_manager_visible_review_expenses_page'
  )
ORDER BY p.proname;

-- ---------------------------------------------------------------------------
-- 5. Column sanity — proves the columns the old migration referenced are absent
--    and the ones the new migration relies on are present.
-- ---------------------------------------------------------------------------
SELECT
  'expenses_columns' AS check_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'expenses'
  AND column_name IN (
    'id', 'user_id', 'organization_id', 'status', 'updated_at', 'created_at',
    'assigned_engineer_id', 'assigned_reviewer_id', 'approval_tier', 'batch_id',
    -- these three should return NO rows; the 2026-07-30 migration referenced them
    'description', 'amount', 'currency'
  )
ORDER BY column_name;

SELECT
  'teams_role_columns' AS check_name,
  column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'teams'
  AND column_name IN ('manager_user_id', 'executive_user_id', 'team_leader_user_id')
ORDER BY column_name;

-- ---------------------------------------------------------------------------
-- 6. Expected scope for the reported reviewers (run as a superuser/service role;
--    auth.uid() is NULL there, so these use explicit ids rather than the RPCs).
--
--    Kunvar Thakor : 6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c  (expect ~226 / ~6,088)
--    Chirag Panchal: ae45a095-547c-4d24-b1c2-e51762f3720b  (expect ~166 / ~433)
--    Organization  : 6709c1fe-e8c8-404d-bc68-d1edda923344
-- ---------------------------------------------------------------------------
WITH RECURSIVE
params AS (
  SELECT
    '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid AS org_id,
    '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'::uuid AS reviewer_id
),
org_profiles AS (
  SELECT p.user_id, p.reporting_engineer_id
  FROM profiles p, params
  WHERE p.organization_id = params.org_id
),
reporting_tree AS (
  SELECT op.user_id, ARRAY[params.reviewer_id, op.user_id] AS visited
  FROM org_profiles op, params
  WHERE op.reporting_engineer_id = params.reviewer_id
  UNION ALL
  SELECT op.user_id, rt.visited || op.user_id
  FROM org_profiles op
  JOIN reporting_tree rt ON op.reporting_engineer_id = rt.user_id
  WHERE NOT (op.user_id = ANY (rt.visited))
    AND array_length(rt.visited, 1) < 64
)
SELECT
  'expected_team_size' AS check_name,
  COUNT(DISTINCT rt.user_id) AS team_size
FROM reporting_tree rt;

-- Expense count for that same tree (compare against 6,088).
WITH RECURSIVE
params AS (
  SELECT
    '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid AS org_id,
    '6d75cd1f-b01f-4d2e-8644-7d34ccc78b1c'::uuid AS reviewer_id
),
org_profiles AS (
  SELECT p.user_id, p.reporting_engineer_id
  FROM profiles p, params
  WHERE p.organization_id = params.org_id
),
reporting_tree AS (
  SELECT op.user_id, ARRAY[params.reviewer_id, op.user_id] AS visited
  FROM org_profiles op, params
  WHERE op.reporting_engineer_id = params.reviewer_id
  UNION ALL
  SELECT op.user_id, rt.visited || op.user_id
  FROM org_profiles op
  JOIN reporting_tree rt ON op.reporting_engineer_id = rt.user_id
  WHERE NOT (op.user_id = ANY (rt.visited))
    AND array_length(rt.visited, 1) < 64
)
SELECT
  'expected_expense_total' AS check_name,
  COUNT(*) AS expense_total
FROM expenses e, params
WHERE e.organization_id = params.org_id
  AND e.status IN (
    'submitted', 'verified', 'approved', 'rejected', 'edited',
    'under_review', 'level_1_verified', 'level_2_verified'
  )
  AND (
    e.user_id IN (SELECT rt.user_id FROM reporting_tree rt)
    OR e.assigned_engineer_id = params.reviewer_id
    OR e.assigned_reviewer_id = params.reviewer_id
  );

-- Status breakdown, to compare against the reported status list.
SELECT
  'status_breakdown' AS check_name,
  e.status,
  COUNT(*) AS row_count
FROM expenses e
WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
GROUP BY e.status
ORDER BY row_count DESC;

-- ---------------------------------------------------------------------------
-- 7. Rows with a NULL updated_at — these are the rows a naive keyset cursor
--    would skip permanently. Should be safe because we COALESCE, but worth
--    knowing the magnitude.
-- ---------------------------------------------------------------------------
SELECT
  'null_updated_at_rows' AS check_name,
  COUNT(*) FILTER (WHERE e.updated_at IS NULL) AS null_updated_at,
  COUNT(*) FILTER (WHERE e.updated_at IS NULL AND e.created_at IS NULL) AS null_both,
  COUNT(*) AS total_rows
FROM expenses e
WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid;
