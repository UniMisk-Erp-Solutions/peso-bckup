-- DOC-103 — Server-side generated report snapshots (Option A: full snapshot + dedupe + retention)
--
-- WHY THIS EXISTS
--   Until now a generated report existed only in the browser's React Query cache.
--   Closing the tab destroyed it; there was no record that a report had ever been
--   produced, and no way to reopen the exact numbers someone saw on a given day.
--   For a finance system whose exports feed reimbursement decisions, that is a
--   missing audit trail.
--
-- DESIGN — two tables, deliberately split
--   generated_reports      one row per DISTINCT report content (heavy `payload`)
--   generated_report_runs  one row per generate CLICK (light: who / when / which)
--
--   Every generation is recorded in `generated_report_runs`, so "each and every
--   generated report is stored" holds literally. But regenerating the same
--   filters over unchanged data reuses the existing snapshot instead of writing
--   a second multi-megabyte copy. Production MicroLink produces ~4,141 report
--   rows (~2 MB as jsonb) per generation against a 151 MB database, so an
--   undeduped design would outgrow shared_buffers within weeks.
--
-- RETENTION
--   `expires_at` defaults to 90 days. purge_expired_generated_report_snapshots_v1()
--   deletes past that. Schedule it with pg_cron (already installed) — see §7 below.
--   Nothing purges automatically until that job is created; this migration does
--   not create it, so retention is opt-in and visible.
--
-- SAFETY
--   * Every SECURITY DEFINER function pins search_path (audit finding A2).
--   * anon is revoked from every routine here — these are authenticated-only.
--   * RLS is enabled on both tables (audit finding A1 was an un-RLS'd table).
--   * Additive only: no existing table, function, policy or index is altered.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Snapshot table (deduped, heavy)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.generated_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  report_type      text NOT NULL,
  content_hash     text NOT NULL,
  filters          jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload          jsonb NOT NULL,
  row_count        integer NOT NULL,
  snapshot_at      timestamptz,
  first_generated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  first_generated_at timestamptz NOT NULL DEFAULT now(),
  last_generated_at  timestamptz NOT NULL DEFAULT now(),
  generation_count integer NOT NULL DEFAULT 1,
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  CONSTRAINT generated_reports_row_count_nonneg CHECK (row_count >= 0),
  CONSTRAINT generated_reports_type_allowed
    CHECK (report_type IN ('daily_project_expense', 'detailed_expense',
                           'claim_verification', 'claim_approval'))
);

-- The dedupe key. Same org + same report kind + same content = same snapshot.
CREATE UNIQUE INDEX IF NOT EXISTS generated_reports_dedupe_idx
  ON public.generated_reports (organization_id, report_type, content_hash);

-- Listing: newest first, per org and type.
CREATE INDEX IF NOT EXISTS generated_reports_listing_idx
  ON public.generated_reports (organization_id, report_type, last_generated_at DESC);

-- Retention sweep.
CREATE INDEX IF NOT EXISTS generated_reports_expiry_idx
  ON public.generated_reports (expires_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Run log (one row per click, light)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.generated_report_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        uuid NOT NULL REFERENCES public.generated_reports(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  generated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  was_deduped      boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS generated_report_runs_org_time_idx
  ON public.generated_report_runs (organization_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS generated_report_runs_report_idx
  ON public.generated_report_runs (report_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS — org members read their own org; only the RPCs write
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.generated_reports     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_report_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org admins read generated reports" ON public.generated_reports;
CREATE POLICY "Org admins read generated reports"
  ON public.generated_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.organization_id = generated_reports.organization_id
        AND om.is_active
        AND om.role IN ('admin', 'engineer', 'team_leader', 'executive')
    )
  );

DROP POLICY IF EXISTS "Org admins read generated report runs" ON public.generated_report_runs;
CREATE POLICY "Org admins read generated report runs"
  ON public.generated_report_runs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.organization_id = generated_report_runs.organization_id
        AND om.is_active
        AND om.role IN ('admin', 'engineer', 'team_leader', 'executive')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. save_generated_report_v1 — upsert-on-hash, always logs the run
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_generated_report_v1(
  p_organization_id uuid,
  p_report_type     text,
  p_content_hash    text,
  p_filters         jsonb,
  p_payload         jsonb,
  p_row_count       integer,
  p_snapshot_at     timestamptz DEFAULT NULL,
  p_retention_days  integer     DEFAULT 90
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid        uuid := auth.uid();
  v_report_id  uuid;
  v_deduped    boolean := false;
  v_retention  integer := greatest(1, least(coalesce(p_retention_days, 90), 3650));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- Caller must be an active member of the org with a reporting role.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = p_organization_id
      AND om.is_active
      AND om.role IN ('admin', 'engineer', 'team_leader', 'executive')
  ) THEN
    RAISE EXCEPTION 'not permitted for this organization' USING ERRCODE = '42501';
  END IF;

  IF p_content_hash IS NULL OR length(p_content_hash) < 16 THEN
    RAISE EXCEPTION 'content hash missing or too short' USING ERRCODE = '22023';
  END IF;

  -- Dedupe: same org + type + content already stored? Touch it, don't rewrite.
  SELECT id INTO v_report_id
  FROM public.generated_reports
  WHERE organization_id = p_organization_id
    AND report_type     = p_report_type
    AND content_hash    = p_content_hash;

  IF v_report_id IS NOT NULL THEN
    v_deduped := true;
    UPDATE public.generated_reports
       SET last_generated_at = now(),
           generation_count  = generation_count + 1,
           -- Regenerating renews the retention window; an actively used
           -- snapshot should not expire out from under its users.
           expires_at        = now() + make_interval(days => v_retention)
     WHERE id = v_report_id;
  ELSE
    INSERT INTO public.generated_reports (
      organization_id, report_type, content_hash, filters, payload,
      row_count, snapshot_at, first_generated_by, expires_at
    ) VALUES (
      p_organization_id, p_report_type, p_content_hash,
      coalesce(p_filters, '{}'::jsonb), p_payload,
      greatest(coalesce(p_row_count, 0), 0), p_snapshot_at, v_uid,
      now() + make_interval(days => v_retention)
    )
    RETURNING id INTO v_report_id;
  END IF;

  -- Every generation is logged, deduped or not.
  INSERT INTO public.generated_report_runs (
    report_id, organization_id, generated_by, was_deduped
  ) VALUES (v_report_id, p_organization_id, v_uid, v_deduped);

  RETURN jsonb_build_object(
    'report_id', v_report_id,
    'deduped',   v_deduped,
    'row_count', greatest(coalesce(p_row_count, 0), 0)
  );
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. list_generated_reports_v1 — metadata only, never ships payload
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_generated_reports_v1(
  p_organization_id uuid,
  p_report_type     text DEFAULT NULL,
  p_limit           integer DEFAULT 50,
  p_offset          integer DEFAULT 0
)
RETURNS TABLE (
  id                 uuid,
  report_type        text,
  filters            jsonb,
  row_count          integer,
  snapshot_at        timestamptz,
  first_generated_at timestamptz,
  last_generated_at  timestamptz,
  generation_count   integer,
  expires_at         timestamptz,
  generated_by_name  text,
  payload_bytes      bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT g.id, g.report_type, g.filters, g.row_count, g.snapshot_at,
         g.first_generated_at, g.last_generated_at, g.generation_count,
         g.expires_at,
         COALESCE(p.name, '—') AS generated_by_name,
         pg_column_size(g.payload)::bigint AS payload_bytes
  FROM public.generated_reports g
  LEFT JOIN public.profiles p ON p.user_id = g.first_generated_by
  WHERE g.organization_id = p_organization_id
    AND (p_report_type IS NULL OR g.report_type = p_report_type)
    AND EXISTS (
      SELECT 1 FROM public.organization_memberships om
      WHERE om.user_id = (SELECT auth.uid())
        AND om.organization_id = p_organization_id
        AND om.is_active
        AND om.role IN ('admin', 'engineer', 'team_leader', 'executive')
    )
  ORDER BY g.last_generated_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(0, coalesce(p_offset, 0));
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. get_generated_report_v1 — one snapshot, payload included
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_generated_report_v1(p_report_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.generated_reports%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM public.generated_reports WHERE id = p_report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report not found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships om
    WHERE om.user_id = v_uid
      AND om.organization_id = v_row.organization_id
      AND om.is_active
      AND om.role IN ('admin', 'engineer', 'team_leader', 'executive')
  ) THEN
    RAISE EXCEPTION 'not permitted for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'id',                v_row.id,
    'report_type',       v_row.report_type,
    'filters',           v_row.filters,
    'payload',           v_row.payload,
    'row_count',         v_row.row_count,
    'snapshot_at',       v_row.snapshot_at,
    'first_generated_at',v_row.first_generated_at,
    'last_generated_at', v_row.last_generated_at,
    'generation_count',  v_row.generation_count,
    'expires_at',        v_row.expires_at
  );
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Retention sweep — NOT scheduled by this migration
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_expired_generated_report_snapshots_v1()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_deleted integer;
BEGIN
  DELETE FROM public.generated_reports WHERE expires_at < now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

-- To enable retention, run this ONCE, separately (pg_cron is already installed):
--   SELECT cron.schedule('purge-generated-reports', '17 3 * * *',
--                        $$SELECT public.purge_expired_generated_report_snapshots_v1()$$);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Grants — authenticated only; anon is explicitly revoked
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON public.generated_reports     FROM anon;
REVOKE ALL ON public.generated_report_runs FROM anon;
GRANT SELECT ON public.generated_reports     TO authenticated;
GRANT SELECT ON public.generated_report_runs TO authenticated;

REVOKE ALL ON FUNCTION public.save_generated_report_v1(uuid, text, text, jsonb, jsonb, integer, timestamptz, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_generated_reports_v1(uuid, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_generated_report_v1(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_expired_generated_report_snapshots_v1() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_generated_report_v1(uuid, text, text, jsonb, jsonb, integer, timestamptz, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_generated_reports_v1(uuid, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_generated_report_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_generated_report_snapshots_v1() TO service_role;

COMMENT ON TABLE public.generated_reports IS
  'DOC-103 — deduped snapshots of generated reports. One row per distinct content hash.';
COMMENT ON TABLE public.generated_report_runs IS
  'DOC-103 — one row per generate click, including deduped repeats. The audit trail.';
