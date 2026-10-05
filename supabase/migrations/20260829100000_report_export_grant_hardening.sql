-- Report export job infrastructure — close a live grant-hygiene gap.
--
-- ============================================================================
-- STATUS: BRANCH ONLY. NOT APPLIED TO ANY DATABASE.
-- ============================================================================
--
-- SOURCE OF THIS FILE: `Documentations MD/PRODUCTION_BACKEND_MIGRATION_AUDIT.md`
-- (2026-08-29 read-only SSH/psql audit of Production, Coolify stack
-- `evo3o0fdjaroxq7uohrm21cp`). This is a FORWARD-ONLY delta migration, not a
-- re-run of `20260827150000_report_export_jobs.sql` or
-- `20260827170000_server_side_expense_reports.sql` — those two files' table,
-- RLS, bucket, and all ten job/report functions are already live in
-- Production (confirmed via full `pg_get_functiondef` retrieval and
-- signature/body comparison), applied manually/directly outside this
-- integration's own tracked history. Re-running either file wholesale would
-- either silently no-op (`CREATE TABLE IF NOT EXISTS`) or, at best, be a
-- harmless but unverified full-body replay — this file instead contains
-- ONLY the two confirmed-missing statements.
--
-- THE GAP
--   PostgreSQL grants PUBLIC (and therefore, transitively, `anon` and
--   `authenticated`) EXECUTE on a newly created function by default, unless
--   explicitly revoked. Both source files already contain the correct
--   `REVOKE ALL ... FROM PUBLIC` / `FROM anon` statements for these two
--   functions — but live inspection proved those specific REVOKE statements
--   were never actually run, even though the functions themselves (and
--   every OTHER function's grants in the same two files) are live and
--   correct. This is the ONE remaining M3-classified gap the audit's Phase
--   1 was tasked with proving or disproving — proven: it is the only one.
--
--   1. `create_expense_report_export_job_v1` — a user-facing enqueue RPC.
--      Its own internal `auth.uid() IS NULL` check already rejects an
--      unauthenticated caller, so this is not an active data-exposure
--      vulnerability today, but it is a real defense-in-depth gap: the
--      function is currently reachable by the `anon` role at the grant
--      layer, contrary to its own migration file's stated intent.
--
--   2. `_report_humanize_field_key_v1` — a private, `_`-prefixed, pure
--      scalar text-transformation helper (no table access, IMMUTABLE, no
--      SECURITY DEFINER even needed). Zero data-exposure risk either way,
--      but it is meant to be an internal implementation detail of
--      `_report_expense_custom_fields_v1`, not a directly callable surface
--      for `anon` AND `authenticated` alike, which is what live grants
--      currently allow.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   It does not touch `report_export_jobs.format`'s column DEFAULT
--   ('xlsx' live vs 'csv' in the original migration file), and it does not
--   touch the `report_export_jobs_org_created_idx` / would-be
--   `report_export_jobs_org_type_created_idx` index naming/column
--   difference. Both were investigated in the 2026-08-29 audit and found to
--   have NO functional impact: every current enqueue path
--   (`create_daily_project_report_export_job_v1`,
--   `create_expense_report_export_job_v1`) always explicitly passes
--   `p_format`, defaulting to `'csv'` at the FUNCTION parameter level in
--   both cases — the table column default is never actually exercised by
--   any code path in this repository. The index difference has no measurable
--   performance impact at this table's actual scale (a job queue with a
--   7-day completed-job expiry; 0 rows at the last verified point). Per the
--   explicit instruction to prefer leaving Production alone when drift has
--   no functional or meaningful performance impact, neither is changed
--   here. See the audit document's Phase 4 section for the full reasoning.
-- ============================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_expense_report_export_job_v1(uuid, text, jsonb, boolean, text) TO authenticated;

REVOKE ALL ON FUNCTION public._report_humanize_field_key_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._report_humanize_field_key_v1(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public._report_humanize_field_key_v1(text) TO service_role;

COMMIT;
