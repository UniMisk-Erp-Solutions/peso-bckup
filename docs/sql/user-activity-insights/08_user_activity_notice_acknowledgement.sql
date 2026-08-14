-- ============================================================
-- User Activity Insights — Notice Acknowledgement
-- docs/sql/user-activity-insights/08_user_activity_notice_acknowledgement.sql
--
-- Purpose:
--   Stores that a user saw and acknowledged the activity tracking notice.
--   Prevents the tracker from silently running before the user is informed.
--
-- Creates:
--   TABLE  public.user_activity_notice_acknowledgements
--   POLICY "Users read own acknowledgements"
--   POLICY "Org admins read org acknowledgements"
--   FUNCTION public.has_acknowledged_user_activity_notice(text) -> boolean
--   FUNCTION public.acknowledge_user_activity_notice(text) -> void
--
-- Safety:
--   - CREATE TABLE IF NOT EXISTS (idempotent)
--   - CREATE OR REPLACE FUNCTION (idempotent)
--   - No DROP, no ALTER TABLE on existing tables
--   - No changes to expenses, rollups, triggers, or RLS on other tables
--   - No DELETE, no UPDATE on existing business data
--
-- Run order:
--   1. supabase/migrations/290713_0900_user_activity_insights.sql (already applied)
--   2. 06_hotfix_summary_sql_language_function.sql (already applied)
--   3. This file (08_user_activity_notice_acknowledgement.sql) ← run now
--   4. 09_verify_user_activity_notice_acknowledgement.sql (verification)
-- ============================================================


-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_activity_notice_acknowledgements (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id)  ON DELETE CASCADE,
  user_id          uuid        NOT NULL REFERENCES auth.users(id)            ON DELETE CASCADE,
  notice_version   text        NOT NULL DEFAULT 'user_activity_notice_v1',
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, user_id, notice_version)
);

COMMENT ON TABLE public.user_activity_notice_acknowledgements IS
  'Records that a specific user saw the activity tracking notice for their organization. '
  'Does not store any activity data itself. Used to block the tracker from running silently '
  'before the user has been informed. Keyed by (organization_id, user_id, notice_version) '
  'so a new notice_version forces re-acknowledgement across the org.';

COMMENT ON COLUMN public.user_activity_notice_acknowledgements.notice_version IS
  'Versioned notice key. Increment (e.g. user_activity_notice_v2) to require re-acknowledgement '
  'if the notice copy changes materially.';


-- ── Row-Level Security ─────────────────────────────────────────────────────────

ALTER TABLE public.user_activity_notice_acknowledgements ENABLE ROW LEVEL SECURITY;

-- Users can read their own acknowledgement rows
-- DROP IF EXISTS makes this idempotent for re-runs (see also file 14).
DROP POLICY IF EXISTS "Users read own acknowledgements"
  ON public.user_activity_notice_acknowledgements;
CREATE POLICY "Users read own acknowledgements"
  ON public.user_activity_notice_acknowledgements
  FOR SELECT
  USING (user_id = auth.uid());

-- Org admins can read all acknowledgement rows for their org (for reporting)
DROP POLICY IF EXISTS "Org admins read org acknowledgements"
  ON public.user_activity_notice_acknowledgements;
CREATE POLICY "Org admins read org acknowledgements"
  ON public.user_activity_notice_acknowledgements
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id         = auth.uid()
        AND om.organization_id = user_activity_notice_acknowledgements.organization_id
        AND om.role::text      = 'admin'
    )
  );

-- No client-side INSERT policy: inserts go through the SECURITY DEFINER RPC only.


-- ── RPC: has_acknowledged_user_activity_notice ────────────────────────────────
--
-- Returns true if:
--   (a) feature is disabled for caller's org (no notice needed)
--   (b) caller has already acknowledged the notice for their org + version
-- Returns false if:
--   caller is not authenticated, OR feature is enabled and no acknowledgement exists

CREATE OR REPLACE FUNCTION public.has_acknowledged_user_activity_notice(
  p_notice_version text DEFAULT 'user_activity_notice_v1'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    -- Not authenticated → false
    WHEN auth.uid() IS NULL THEN false
    -- Feature not enabled for caller's org → true (no notice needed)
    WHEN NOT EXISTS (
      SELECT 1
      FROM public.organization_memberships om
      WHERE om.user_id = auth.uid()
        AND public.is_user_activity_insights_enabled(om.organization_id)
      LIMIT 1
    ) THEN true
    -- Feature enabled → check acknowledgement row
    ELSE EXISTS (
      SELECT 1
      FROM public.user_activity_notice_acknowledgements a
      JOIN public.organization_memberships om
        ON om.organization_id = a.organization_id
       AND om.user_id         = auth.uid()
      WHERE a.user_id        = auth.uid()
        AND a.notice_version = p_notice_version
    )
  END;
$$;

COMMENT ON FUNCTION public.has_acknowledged_user_activity_notice IS
  'Returns true when the calling user has acknowledged the activity tracking notice '
  '(or when the feature is disabled, so the notice is not required). '
  'Returns false when feature is enabled but no acknowledgement row exists. '
  'LANGUAGE sql STABLE SECURITY DEFINER; safe to call on every page load.';


-- ── RPC: acknowledge_user_activity_notice ─────────────────────────────────────
--
-- Inserts or updates the acknowledgement row for the calling user.
-- No-op when feature is disabled or caller is unauthenticated.

CREATE OR REPLACE FUNCTION public.acknowledge_user_activity_notice(
  p_notice_version text DEFAULT 'user_activity_notice_v1'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id  uuid := auth.uid();
  v_org_id     uuid;
BEGIN
  -- Nothing to do if unauthenticated
  IF v_caller_id IS NULL THEN
    RETURN;
  END IF;

  -- Find the caller's org that has the feature enabled
  SELECT om.organization_id
  INTO   v_org_id
  FROM   public.organization_memberships om
  WHERE  om.user_id = v_caller_id
    AND  public.is_user_activity_insights_enabled(om.organization_id)
  LIMIT 1;

  -- Feature disabled for this user's org: no-op
  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.user_activity_notice_acknowledgements
    (organization_id, user_id, notice_version, acknowledged_at)
  VALUES
    (v_org_id, v_caller_id, p_notice_version, now())
  ON CONFLICT (organization_id, user_id, notice_version)
  DO UPDATE SET acknowledged_at = now();
END;
$$;

COMMENT ON FUNCTION public.acknowledge_user_activity_notice IS
  'Records that the calling user acknowledged the activity tracking notice. '
  'Upserts on (organization_id, user_id, notice_version). '
  'No-op if feature is disabled or caller is unauthenticated. '
  'SECURITY DEFINER so client does not need a direct INSERT policy on the table.';
