-- ============================================================
-- FILE: 03_verify_data_exists.sql
-- PURPOSE: Prove whether verified expenses actually exist in the
--          database for this org. If UI shows "No expenses found"
--          even after indexes are created, run this to determine
--          whether it is a data problem or a filter/RLS problem.
-- SAFE: Read-only. No data changes.
-- ORG ID: 6709c1fe-e8c8-404d-bc68-d1edda923344
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- QUERY 1: Count verified expenses by status
-- ──────────────────────────────────────────────────────────
-- Expected if expenses exist: rows with status and counts > 0.
-- If this returns 0 rows: the database has NO verified expenses
-- for this org → the "No expenses found" UI message is correct.
-- The fix then is data (verification workflow), not the index.

SELECT
  status,
  COUNT(*) AS expense_count
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND status IN ('verified', 'level_1_verified', 'level_2_verified')
GROUP BY status
ORDER BY status;


-- ──────────────────────────────────────────────────────────
-- QUERY 2: Total count of all verified-type expenses
-- ──────────────────────────────────────────────────────────

SELECT COUNT(*) AS total_verified_like_expenses
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND status IN ('verified', 'level_1_verified', 'level_2_verified');


-- ──────────────────────────────────────────────────────────
-- QUERY 3: Full status distribution for this org
-- ──────────────────────────────────────────────────────────
-- This shows ALL statuses (submitted, approved, verified, etc.)
-- so we can see where expenses are in the workflow.
-- If most expenses are "submitted" but none are "verified",
-- the verification step has not been done yet.

SELECT
  status,
  COUNT(*) AS expense_count
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
GROUP BY status
ORDER BY expense_count DESC;


-- ──────────────────────────────────────────────────────────
-- QUERY 4: Latest 20 verified expenses (raw data sample)
-- ──────────────────────────────────────────────────────────
-- If Query 1 shows rows exist but UI still shows nothing,
-- paste these rows back — they confirm the data the frontend
-- should be receiving.

SELECT
  id,
  user_id,
  title,
  total_amount,
  status,
  created_at,
  category,
  batch_id
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND status IN ('verified', 'level_1_verified', 'level_2_verified')
ORDER BY created_at DESC
LIMIT 20;
