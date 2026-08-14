-- ============================================================
-- FILE: 05_postgrest_exact_query_debug.sql
-- PURPOSE: Run the exact query that PostgREST generates for
--          the Team Reports Claim Verification List, both with
--          and without LIMIT, to confirm results exist and
--          are returned correctly.
-- SAFE: Read-only. No data changes.
-- ORG ID: 6709c1fe-e8c8-404d-bc68-d1edda923344
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- QUERY 1: Exact PostgREST equivalent WITH LIMIT 100
-- ──────────────────────────────────────────────────────────
-- This is what the frontend sends after the teamReportsScope fix.
-- Should return up to 100 rows if:
--   (a) the index exists (file 02 confirms)
--   (b) verified expenses exist (file 03 confirms)
--
-- If this returns 0 rows → data problem, not index.
-- If this times out (>8s) → index still missing, run file 01b.
-- If this succeeds (<1s) → DB is fine; issue is frontend or RLS.

SELECT
  id,
  user_id,
  title,
  total_amount,
  status,
  created_at,
  trip_start,
  trip_end,
  category,
  purpose,
  destination,
  transaction_number,
  batch_id
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND status IN ('verified', 'level_1_verified', 'level_2_verified')
ORDER BY created_at DESC
LIMIT 100;


-- ──────────────────────────────────────────────────────────
-- QUERY 2: Total matching row count (no LIMIT)
-- ──────────────────────────────────────────────────────────
-- If this is very high (>5000), pagination will be important
-- in future. For now, index makes it fast regardless.

SELECT COUNT(*) AS total_matching
FROM public.expenses
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND status IN ('verified', 'level_1_verified', 'level_2_verified');


-- ──────────────────────────────────────────────────────────
-- QUERY 3: RLS check — run as the authenticated user
-- ──────────────────────────────────────────────────────────
-- If Query 1 returns rows in SQL Editor (running as postgres/service_role)
-- but the frontend still gets 0 rows, it may be an RLS policy blocking
-- the authenticated user from reading these expenses.
--
-- To test RLS: set the role to the authenticated user's role, then
-- set the JWT claims, then run the query.
-- This is complex in SQL Editor — simpler approach is to check whether
-- the RLS policy "Engineers can view team reporting expenses" exists
-- and covers status IN ('verified', 'level_1_verified', 'level_2_verified').

SELECT
  policyname,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'expenses'
  AND policyname ILIKE '%team%'
   OR policyname ILIKE '%report%'
   OR policyname ILIKE '%verif%'
   OR policyname ILIKE '%review%'
ORDER BY policyname;
