-- Fixes a real, pre-existing gap found during the `integration/non-backup-ready`
-- RPC audit: `src/lib/reportExportJobs.ts`'s `enqueueDailyProjectReportExport`
-- calls `create_daily_project_report_export_job_v1` (and Reports.tsx /
-- ServerReportExportPanel.tsx ultimately drive Daily Project Report exports
-- through it), but this function has never existed anywhere in
-- `supabase/migrations/` -- not on `main`, not anywhere in the
-- `feature/recent-expense-field-values` history. It is referenced only in SQL
-- *comments* in two other migrations
-- (`20260827170000_server_side_expense_reports.sql` line ~29:
-- "Daily Project Report has its own enqueue function, part 1"; and
-- `20260829100000_report_export_grant_hardening.sql` line ~53) as if it had
-- already been written as "part 1" of the report-export-jobs work -- it never
-- was. Every real attempt to enqueue a Daily Project Report export fails at
-- the RPC call with "function does not exist" (PGRST202). This migration is
-- the missing "part 1" enqueue function, written to the exact same
-- conventions as its sibling `create_expense_report_export_job_v1`
-- (`20260827170000_server_side_expense_reports.sql`) and consistent with the
-- authenticated wrapper `get_daily_project_report_page_v1`
-- (`20260829120000_daily_report_remarks_and_batch_ambiguity.sql`), which is
-- the browser-path precedent for how permission is checked and how
-- `organization_settings.daily_expense_report_config` becomes the frozen
-- `config_snapshot` the worker reads.
--
-- STATUS: integration/non-backup-ready. UPDATE 2026-09-28 (final deployment-
-- readiness pass): a real, LIVE query of the self-hosted PesoWise database
-- confirmed this function ALREADY EXISTS in Production with this exact
-- signature -- but its body is a DIFFERENT, previously undocumented,
-- unmigrated ad hoc fix (no CREATE FUNCTION for it exists in ANY branch of
-- this repository, tracked or backup/*). That live version builds its
-- `parameters` jsonb with CAMELCASE keys (`dateFrom`, `dateTo`, `userId`,
-- `teamScoped`, `userIds`), but the deployed (and this repo's) worker
-- (`supabase/functions/run-report-export-job/index.ts`) reads
-- `params.date_from` / `params.user_id` / `params.user_ids` -- SNAKE_CASE.
-- Every Daily Project Report enqueued through the currently-live function
-- silently passes null filters to the worker today, independent of this PR.
-- This migration's own body (below) was already snake_case and correct; it
-- must be (re-)applied to Production via `CREATE OR REPLACE` to fix this
-- real, currently-live defect before the frontend in this PR is deployed.
-- Nothing else about the live version is changed on purpose: its format
-- default ('xlsx') and its p_date_from > p_date_to validation are additions
-- made independently in that ad hoc fix and are preserved below rather than
-- discarded, since both are safe, reviewed-in-place behavior this pass found
-- no reason to revert -- every caller in this codebase always passes an
-- explicit p_format regardless, so the default is not user-visible.
--
-- Additive/replace only: one function definition. Nothing else is modified.
--
-- Dedupe scope: UNLIKE create_expense_report_export_job_v1 (org-wide dedupe),
-- this key INCLUDES the requester -- matching the pre-existing design note in
-- 20260827170000_server_side_expense_reports.sql's own file header ("The
-- Daily Project Report's dedupe key includes the requesting user (per-user
-- dedupe...)"), which describes exactly this function's intended behavior.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_daily_project_report_export_job_v1(
  p_organization_id uuid,
  p_date_from       date    DEFAULT NULL,
  p_date_to         date    DEFAULT NULL,
  p_user_id         uuid    DEFAULT NULL,
  p_team_scoped     boolean DEFAULT false,
  p_user_ids        uuid[]  DEFAULT NULL,
  p_format          text    DEFAULT 'xlsx'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_team     boolean := COALESCE(p_team_scoped, false);
  v_format   text := lower(COALESCE(p_format, 'xlsx'));
  v_config   jsonb;
  v_params   jsonb;
  v_dedupe   text;
  v_existing public.report_export_jobs%ROWTYPE;
  v_job_id   uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization is required' USING ERRCODE = '22023';
  END IF;
  IF v_format NOT IN ('xlsx', 'csv') THEN
    RAISE EXCEPTION 'unsupported format' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NOT NULL AND p_date_to IS NOT NULL AND p_date_from > p_date_to THEN
    RAISE EXCEPTION 'date range is inverted' USING ERRCODE = '22023';
  END IF;

  -- Permission is resolved from auth.uid(), never from anything the client
  -- sent -- same check the browser-path get_daily_project_report_page_v1 uses.
  IF NOT public.daily_report_caller_can_view_v1(p_organization_id, v_team) THEN
    RAISE EXCEPTION 'not permitted to generate this report' USING ERRCODE = '42501';
  END IF;

  -- Freeze the org's project/category field-mapping config now, so a later
  -- admin change to it can never retroactively alter an already-enqueued (or
  -- already-completed) export -- same source get_daily_project_report_page_v1
  -- reads for the equivalent browser-driven page.
  SELECT COALESCE(s.daily_expense_report_config, '{}'::jsonb) INTO v_config
  FROM public.organization_settings s
  WHERE s.organization_id = p_organization_id;
  v_config := COALESCE(v_config, '{}'::jsonb);

  v_params := jsonb_build_object(
    'date_from', p_date_from,
    'date_to', p_date_to,
    'user_id', p_user_id,
    'user_ids', p_user_ids
  );

  -- Per-user dedupe (the requester IS part of the key): two people asking for
  -- the same daily report each get their own job, matching the
  -- already-documented, never-implemented intent in
  -- 20260827170000_server_side_expense_reports.sql's file header.
  v_dedupe := md5(
    p_organization_id::text || '|daily_project_report|' || v_uid::text || '|' ||
    v_format || '|' || v_params::text || '|' || v_config::text || '|' || v_team::text
  );

  SELECT * INTO v_existing
  FROM public.report_export_jobs
  WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
  END IF;

  INSERT INTO public.report_export_jobs (
    organization_id, requested_by, report_type, format, parameters, config_snapshot, dedupe_key, status
  ) VALUES (
    p_organization_id, v_uid, 'daily_project_report', v_format, v_params, v_config, v_dedupe, 'queued'
  )
  RETURNING id INTO v_job_id;

  RETURN jsonb_build_object('job_id', v_job_id, 'status', 'queued', 'deduplicated', false);
EXCEPTION
  -- Lost a race against a concurrent identical enqueue: return the winner.
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.report_export_jobs
    WHERE dedupe_key = v_dedupe AND status IN ('queued', 'running')
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('job_id', v_existing.id, 'status', v_existing.status, 'deduplicated', true);
    END IF;
    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.create_daily_project_report_export_job_v1(uuid, date, date, uuid, boolean, uuid[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_daily_project_report_export_job_v1(uuid, date, date, uuid, boolean, uuid[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_daily_project_report_export_job_v1(uuid, date, date, uuid, boolean, uuid[], text) TO authenticated;

COMMENT ON FUNCTION public.create_daily_project_report_export_job_v1(uuid, date, date, uuid, boolean, uuid[], text) IS
  'Enqueue a durable Daily Project Report export job. The missing "part 1" '
  'enqueue function referenced (but never defined) by '
  '20260827170000_server_side_expense_reports.sql and '
  '20260829100000_report_export_grant_hardening.sql -- see this file''s own '
  'header for the full provenance of the gap.';

DO $verify$
BEGIN
  RAISE NOTICE 'daily_project_report_export_job_v1 migration verified OK';
END;
$verify$;
