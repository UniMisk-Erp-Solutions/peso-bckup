-- Diagnostics: expense_form_field_values write-path failures
-- (42P10 ON CONFLICT mismatch + 57014 statement timeout on insert)
--
-- READ-ONLY. Safe to run in the Supabase SQL editor against any environment.
-- Run each section and capture output before applying the migration
-- 20260701120000_expense_form_field_values_atomic_write.sql.
--
-- Optionally replace <TEST_EXPENSE_ID> in section G before running it.

-- ---------------------------------------------------------------------------
-- A. Existing constraints on the values table
--    Expectation (pre-fix): NO normal UNIQUE (expense_id, template_id) /
--    (expense_id, branch_field_id) — only a CHECK constraint. This is why
--    PostgREST upsert with on_conflict="expense_id,template_id" raises 42P10.
-- ---------------------------------------------------------------------------
SELECT
  conname,
  contype,                       -- 'u' unique, 'c' check, 'p' pk, 'f' fk
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.expense_form_field_values'::regclass
ORDER BY contype, conname;

-- ---------------------------------------------------------------------------
-- B. Existing indexes
--    Expectation (pre-fix): PARTIAL unique indexes
--    idx_form_field_values_expense_template (... WHERE template_id IS NOT NULL)
--    idx_form_field_values_expense_branch   (... WHERE branch_field_id IS NOT NULL)
--    A partial unique index does NOT satisfy the PostgREST on_conflict target
--    unless the client also sends the matching predicate (it does not).
-- ---------------------------------------------------------------------------
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'expense_form_field_values'
ORDER BY indexname;

-- ---------------------------------------------------------------------------
-- C. Duplicate regular-field rows (must be 0 before adding a normal UNIQUE)
-- ---------------------------------------------------------------------------
SELECT
  expense_id,
  template_id,
  COUNT(*) AS duplicate_count
FROM public.expense_form_field_values
WHERE template_id IS NOT NULL
GROUP BY expense_id, template_id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- ---------------------------------------------------------------------------
-- D. Duplicate branch-field rows (must be 0 before adding a normal UNIQUE)
-- ---------------------------------------------------------------------------
SELECT
  expense_id,
  branch_field_id,
  COUNT(*) AS duplicate_count
FROM public.expense_form_field_values
WHERE branch_field_id IS NOT NULL
GROUP BY expense_id, branch_field_id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;

-- ---------------------------------------------------------------------------
-- E. Invalid rows: both IDs set, or neither set
--    (the CHECK from 20260514120000 should already prevent these, but verify)
-- ---------------------------------------------------------------------------
SELECT
  id,
  expense_id,
  template_id,
  branch_field_id,
  field_value
FROM public.expense_form_field_values
WHERE
  (template_id IS NULL AND branch_field_id IS NULL)
  OR
  (template_id IS NOT NULL AND branch_field_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- F. Current RLS policies on the values table
--    Look for MANY overlapping permissive SELECT policies. PostgREST runs
--    INSERT ... RETURNING *, which forces every permissive SELECT policy to be
--    OR-evaluated per returned row; several do EXISTS(... FROM expenses ...)
--    and IN (... FROM organization_memberships ...). Combined with the INSERT
--    WITH CHECK subquery this is the likely source of the 57014 timeout.
-- ---------------------------------------------------------------------------
SELECT
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'expense_form_field_values'
ORDER BY cmd, policyname;

-- ---------------------------------------------------------------------------
-- F2. Triggers on the values table (a slow AFTER trigger could also time out)
-- ---------------------------------------------------------------------------
SELECT
  tgname,
  tgenabled,
  pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgrelid = 'public.expense_form_field_values'::regclass
  AND NOT tgisinternal
ORDER BY tgname;

-- ---------------------------------------------------------------------------
-- G. Read plan for a single expense (replace the UUID). Should be an index
--    scan on idx_form_field_values_expense, not a seq scan.
-- ---------------------------------------------------------------------------
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT *
-- FROM public.expense_form_field_values
-- WHERE expense_id = '<TEST_EXPENSE_ID>';

-- ---------------------------------------------------------------------------
-- H. Indexes that back RLS predicates (expenses, organization_memberships)
-- ---------------------------------------------------------------------------
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('expenses', 'organization_memberships')
ORDER BY tablename, indexname;
