-- ===========================================================================
-- 05 — Index verification for the reviewer scope RPCs  (DOC-074)
--
-- SELECT-ONLY. This file reports which supporting indexes exist. It creates
-- nothing. Proposed CREATE INDEX statements live in 06_*, and are NOT applied
-- automatically to Production.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Every index currently on the tables the reviewer scope touches
-- ---------------------------------------------------------------------------
SELECT
  'existing_indexes' AS check_name,
  t.relname  AS table_name,
  i.relname  AS index_name,
  pg_get_indexdef(ix.indexrelid) AS definition,
  pg_size_pretty(pg_relation_size(ix.indexrelid)) AS index_size
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname IN (
    'expenses',
    'profiles',
    'organization_memberships',
    'teams',
    'team_members',
    'audit_logs',
    'expense_form_field_values'
  )
ORDER BY t.relname, i.relname;

-- ---------------------------------------------------------------------------
-- 2. Presence check for each index the new RPCs benefit from.
--    `exists = false` is a candidate for 06_*; it is NOT automatically a
--    problem — check 06's notes before creating anything.
-- ---------------------------------------------------------------------------
WITH wanted(table_name, purpose, required_columns) AS (
  VALUES
    ('expenses', 'keyset page scan: org + ordering key',
      ARRAY['organization_id', 'updated_at', 'id']),
    ('expenses', 'scope filter by submitter within org',
      ARRAY['organization_id', 'user_id', 'updated_at', 'id']),
    ('expenses', 'legacy direct assignment (engineer)',
      ARRAY['assigned_engineer_id']),
    ('expenses', 'legacy direct assignment (reviewer)',
      ARRAY['assigned_reviewer_id']),
    ('profiles', 'recursive reporting tree walk',
      ARRAY['organization_id', 'reporting_engineer_id', 'user_id']),
    ('organization_memberships', 'active membership + role lookup',
      ARRAY['organization_id', 'user_id', 'is_active', 'role']),
    ('teams', 'role-aware team ownership (manager)',
      ARRAY['organization_id', 'manager_user_id']),
    ('teams', 'role-aware team ownership (executive)',
      ARRAY['organization_id', 'executive_user_id']),
    ('teams', 'role-aware team ownership (team leader)',
      ARRAY['organization_id', 'team_leader_user_id']),
    ('team_members', 'team membership expansion',
      ARRAY['organization_id', 'team_id', 'user_id']),
    ('audit_logs', 'reviewer history / view-only completed rows',
      ARRAY['organization_id', 'user_id', 'action', 'expense_id']),
    ('expense_form_field_values', 'custom-field enrichment covering index',
      ARRAY['organization_id', 'expense_id'])
)
SELECT
  'index_presence' AS check_name,
  w.table_name,
  w.purpose,
  w.required_columns,
  EXISTS (
    SELECT 1
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = w.table_name
      AND w.required_columns <@ (
        SELECT COALESCE(array_agg(a.attname::text), ARRAY[]::text[])
        FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = t.oid AND a.attnum = k.attnum
      )
  ) AS covering_index_exists
FROM wanted w
ORDER BY w.table_name, w.purpose;

-- ---------------------------------------------------------------------------
-- 3. Plan check — confirm the page RPC uses an index scan rather than a seq scan.
--    Replace the org id if you are checking a different tenant.
--    EXPLAIN does not execute the statement's side effects; this is read-only.
-- ---------------------------------------------------------------------------
EXPLAIN (FORMAT TEXT)
SELECT e.*
FROM public.expenses e
WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
  AND e.status IN (
    'submitted', 'verified', 'approved', 'rejected', 'edited',
    'under_review', 'level_1_verified', 'level_2_verified'
  )
ORDER BY
  COALESCE(e.updated_at, e.created_at, 'epoch'::timestamptz) DESC,
  e.id DESC
LIMIT 250;
