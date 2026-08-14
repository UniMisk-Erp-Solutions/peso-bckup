-- ============================================================
-- User Activity Insights
-- Migration: 290713_0900_user_activity_insights.sql
--
-- DO NOT RUN AUTOMATICALLY. Apply manually in the STAGING Supabase SQL Editor
-- BEFORE enabling the feature flag. Keep the feature disabled first, verify
-- installation using docs/sql/user-activity-insights/00_verify_installation.sql,
-- then enable it for one test org only from Master Admin.
--
-- Tracks visible PesoWise app sessions and daily rollups per user.
-- Does NOT track keystrokes, screenshots, browsing outside PesoWise,
-- MAC addresses, device-level data, or any installed-software info.
--
-- Run order (D7 must precede D6 — RLS policies reference the helper):
--   1. Tables (D3, D4)
--   2. Indexes (D5)
--   3. Helper function: is_user_activity_insights_enabled (D7)  ← must be first
--   4. RLS policies (D6)  ← reference D7 helper
--   5. RPC: start_user_activity_session (D8)
--   6. RPC: record_user_activity_heartbeat (D9)
--   7. RPC: end_user_activity_session (D10)
--   8. RPC: get_user_activity_summary (D11)
--   9. RPC: get_user_activity_timeline (D12)
--  10. RPC: get_user_activity_detail (D13)
--  11. Expense submitted trigger (D14)
--
-- Feature-flag safety guarantee:
--   When user_activity_insights is DISABLED for an org:
--     - Tracker does not start (frontend shouldRun gate)
--     - start_user_activity_session returns NULL (no session/rollup created)
--     - record_user_activity_heartbeat no-ops
--     - end_user_activity_session no-ops
--     - Expense trigger returns NEW immediately (no rollup write)
--     - get_user_activity_summary returns empty result set
--     - get_user_activity_timeline returns empty result set
--     - get_user_activity_detail returns empty result set
--     - RLS SELECT policies block reads of any pre-existing rows
--   Existing data is retained in tables; re-enabling the flag restores
--   full read access without any data loss.
-- ============================================================


-- ============================================================
-- D3. Table: user_activity_sessions
-- One row per browser-tab session for a user.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_activity_sessions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES public.organizations(id)  ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES auth.users(id)            ON DELETE CASCADE,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz NULL,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  -- cumulative seconds the tab was visible during this session
  visible_seconds   integer     NOT NULL DEFAULT 0 CHECK (visible_seconds   >= 0),
  -- number of heartbeat calls received
  heartbeat_count   integer     NOT NULL DEFAULT 0 CHECK (heartbeat_count   >= 0),
  user_agent        text        NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_activity_sessions IS
  'One row per PesoWise browser-tab session. Populated by RPC only; '
  'no direct client INSERT. Tracks visible seconds, not keystrokes.';


-- ============================================================
-- D4. Table: user_activity_daily_rollups
-- One row per (org, user, date). Aggregated by RPCs and trigger.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.user_activity_daily_rollups (
  id                        uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid  NOT NULL REFERENCES public.organizations(id)  ON DELETE CASCADE,
  user_id                   uuid  NOT NULL REFERENCES auth.users(id)            ON DELETE CASCADE,
  activity_date             date  NOT NULL,
  first_seen_at             timestamptz NULL,
  last_seen_at              timestamptz NULL,
  visible_seconds           integer NOT NULL DEFAULT 0 CHECK (visible_seconds           >= 0),
  session_count             integer NOT NULL DEFAULT 0 CHECK (session_count             >= 0),
  expenses_submitted_count  integer NOT NULL DEFAULT 0 CHECK (expenses_submitted_count  >= 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, activity_date)
);

COMMENT ON TABLE public.user_activity_daily_rollups IS
  'Daily activity aggregation per (org, user). Written by RPCs and the '
  'expense-submitted trigger. Do not write from the client directly.';


-- ============================================================
-- D5. Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_user_activity_sessions_org_user_started
  ON public.user_activity_sessions (organization_id, user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_sessions_org_last_seen
  ON public.user_activity_sessions (organization_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_rollups_org_date
  ON public.user_activity_daily_rollups (organization_id, activity_date DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_rollups_org_user_date
  ON public.user_activity_daily_rollups (organization_id, user_id, activity_date DESC);

CREATE INDEX IF NOT EXISTS idx_user_activity_rollups_org_last_seen
  ON public.user_activity_daily_rollups (organization_id, last_seen_at DESC);


-- ============================================================
-- D7. Helper: feature-enabled check
-- Must be created BEFORE D6 RLS policies that call it.
-- Used by write RPCs, the expense trigger, and RLS policies to
-- no-op/block access safely when the feature is off.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_user_activity_insights_enabled(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.organization_features
    WHERE  organization_id = p_organization_id
      AND  feature_key     = 'user_activity_insights'
      AND  enabled         = true
  );
$$;

COMMENT ON FUNCTION public.is_user_activity_insights_enabled IS
  'Returns true when user_activity_insights is enabled for the given org. '
  'Used by RLS policies, write RPCs, and the expense trigger to gate all '
  'activity data reads and writes behind the feature flag.';


-- ============================================================
-- D6. Row-Level Security
--
-- Feature-flag safety: all SELECT policies include a call to
-- is_user_activity_insights_enabled(organization_id) so that:
--   - Any pre-existing rows are invisible when the feature is off.
--   - Toggling the flag off immediately revokes read access.
--   - Re-enabling the flag restores read access without data loss.
-- (D7 helper must be defined before these policies are created.)
-- ============================================================
ALTER TABLE public.user_activity_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_activity_daily_rollups ENABLE ROW LEVEL SECURITY;

-- Admins of the same org can read all sessions — only while feature is enabled.
CREATE POLICY "Org admins can read activity sessions"
  ON public.user_activity_sessions
  FOR SELECT
  USING (
    public.is_user_activity_insights_enabled(organization_id)
    AND organization_id IN (
      SELECT organization_id
      FROM   public.organization_memberships
      WHERE  user_id = auth.uid()
        AND  role    = 'admin'
    )
  );

-- Users can read their own sessions — only while feature is enabled.
CREATE POLICY "Users can read own activity sessions"
  ON public.user_activity_sessions
  FOR SELECT
  USING (
    public.is_user_activity_insights_enabled(organization_id)
    AND user_id = auth.uid()
  );

-- Admins can read daily rollups for their org — only while feature is enabled.
CREATE POLICY "Org admins can read activity rollups"
  ON public.user_activity_daily_rollups
  FOR SELECT
  USING (
    public.is_user_activity_insights_enabled(organization_id)
    AND organization_id IN (
      SELECT organization_id
      FROM   public.organization_memberships
      WHERE  user_id = auth.uid()
        AND  role    = 'admin'
    )
  );

-- Users can read their own rollup rows — only while feature is enabled.
CREATE POLICY "Users can read own activity rollups"
  ON public.user_activity_daily_rollups
  FOR SELECT
  USING (
    public.is_user_activity_insights_enabled(organization_id)
    AND user_id = auth.uid()
  );

-- No direct INSERT/UPDATE/DELETE from the client; all writes go through
-- SECURITY DEFINER RPCs or the expense trigger (also SECURITY DEFINER).
-- Note: is_user_activity_insights_enabled() is STABLE; Postgres may cache
-- the result within a transaction, keeping per-row overhead minimal.


-- ============================================================
-- D8. RPC: start_user_activity_session
-- Called once per tab when the tracker mounts.
-- Returns the new session UUID (or NULL if feature is off).
-- ============================================================
CREATE OR REPLACE FUNCTION public.start_user_activity_session(
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        uuid;
  v_org_id         uuid;
  v_session_id     uuid;
  v_today          date := current_date;
BEGIN
  -- 1. Resolve caller
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING HINT = 'User must be signed in to start an activity session.';
  END IF;

  -- 2. Resolve org (pick the active membership; non-master admins have exactly one org)
  -- role is app_role enum; cast to text before comparing with master_admin
  SELECT organization_id
  INTO   v_org_id
  FROM   public.organization_memberships
  WHERE  user_id    = v_user_id
    AND  role::text <> 'master_admin'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no_organization' USING HINT = 'User has no active organization membership.';
  END IF;

  -- 3. Feature gate — return NULL safely instead of error so tracker can ignore it
  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN NULL;
  END IF;

  -- 4. Insert session row
  INSERT INTO public.user_activity_sessions (organization_id, user_id, user_agent)
  VALUES (v_org_id, v_user_id, p_user_agent)
  RETURNING id INTO v_session_id;

  -- 5. Upsert daily rollup
  INSERT INTO public.user_activity_daily_rollups
    (organization_id, user_id, activity_date, first_seen_at, last_seen_at, session_count)
  VALUES
    (v_org_id, v_user_id, v_today, now(), now(), 1)
  ON CONFLICT (organization_id, user_id, activity_date) DO UPDATE
    SET first_seen_at = COALESCE(user_activity_daily_rollups.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at  = GREATEST(user_activity_daily_rollups.last_seen_at, EXCLUDED.last_seen_at),
        session_count = user_activity_daily_rollups.session_count + 1,
        updated_at    = now();

  RETURN v_session_id;
END;
$$;

COMMENT ON FUNCTION public.start_user_activity_session IS
  'Inserts a session row and upserts the daily rollup for today. '
  'Returns NULL if the feature is disabled so the client-side tracker can stop quietly.';


-- ============================================================
-- D9. RPC: record_user_activity_heartbeat
-- Called every 60 s by the tab leader while visible.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_user_activity_heartbeat(
  p_session_id     uuid,
  p_visible_seconds integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   uuid;
  v_org_id    uuid;
  v_clamped   integer;
  v_today     date := current_date;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Clamp to [0, 120] seconds to prevent inflated counts
  v_clamped := GREATEST(0, LEAST(120, p_visible_seconds));

  -- Verify session ownership and fetch org_id in one query
  SELECT organization_id
  INTO   v_org_id
  FROM   public.user_activity_sessions
  WHERE  id      = p_session_id
    AND  user_id = v_user_id;

  IF v_org_id IS NULL THEN
    -- Unknown session or not owned by this user — no-op silently
    RETURN;
  END IF;

  -- Feature gate — no-op if disabled
  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN;
  END IF;

  -- Update session
  UPDATE public.user_activity_sessions
  SET visible_seconds  = visible_seconds  + v_clamped,
      heartbeat_count  = heartbeat_count  + 1,
      last_seen_at     = now(),
      updated_at       = now()
  WHERE id = p_session_id;

  -- Upsert daily rollup
  INSERT INTO public.user_activity_daily_rollups
    (organization_id, user_id, activity_date, last_seen_at, visible_seconds)
  VALUES
    (v_org_id, v_user_id, v_today, now(), v_clamped)
  ON CONFLICT (organization_id, user_id, activity_date) DO UPDATE
    SET visible_seconds = user_activity_daily_rollups.visible_seconds + EXCLUDED.visible_seconds,
        last_seen_at    = GREATEST(user_activity_daily_rollups.last_seen_at, EXCLUDED.last_seen_at),
        updated_at      = now();
END;
$$;

COMMENT ON FUNCTION public.record_user_activity_heartbeat IS
  'Increments visible_seconds (clamped 0-120) on the session and daily rollup. '
  'No-ops if feature disabled or session not owned by caller.';


-- ============================================================
-- D10. RPC: end_user_activity_session
-- Called on pagehide/beforeunload. Safe to call multiple times.
-- Feature-gated: no-ops when feature is disabled so no writes
-- happen to activity tables after the flag is turned off.
-- ============================================================
CREATE OR REPLACE FUNCTION public.end_user_activity_session(
  p_session_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_org_id  uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN; -- beforeunload can race with signOut; fail silently
  END IF;

  -- Resolve org_id from session ownership check (single query)
  SELECT organization_id
  INTO   v_org_id
  FROM   public.user_activity_sessions
  WHERE  id      = p_session_id
    AND  user_id = v_user_id;

  -- Unknown session or not owned — no-op
  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  -- Feature gate: if feature has been disabled since session started, skip write
  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN;
  END IF;

  -- Mark session as ended (idempotent — COALESCE keeps original ended_at)
  UPDATE public.user_activity_sessions
  SET ended_at     = COALESCE(ended_at, now()),
      last_seen_at = GREATEST(last_seen_at, now()),
      updated_at   = now()
  WHERE id = p_session_id;
END;
$$;

COMMENT ON FUNCTION public.end_user_activity_session IS
  'Marks a session as ended. Idempotent — safe to call multiple times. '
  'Silently no-ops if unauthenticated (race with signOut) or feature disabled.';


-- ============================================================
-- D11. RPC: get_user_activity_summary
-- Admin-only. Returns one row per org member with activity stats.
-- Set-based: uses rollups table, not per-user loops.
--
-- Hotfix 03: role::text casts — app_role enum comparison fix.
-- Hotfix 04: CTE column renaming — partial SQLSTATE 42702 fix.
-- Hotfix 05: rewritten as LANGUAGE sql to eliminate PL/pgSQL
--   RETURNS TABLE output-variable ambiguity (SQLSTATE 42702) entirely.
--   Returns empty set (not exception) when caller not authenticated,
--   not admin, or feature disabled.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_activity_summary(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  user_id                  uuid,
  name                     text,
  email                    text,
  employee_id              text,
  role                     text,
  last_seen_at             timestamptz,
  first_seen_in_range      timestamptz,
  today_visible_seconds    integer,
  today_expenses_submitted integer,
  active_days              integer,
  inactive_days            integer,
  current_inactive_streak  integer,
  total_visible_seconds    integer,
  total_expenses_submitted integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH
  caller AS (
    SELECT auth.uid() AS caller_user_id
  ),
  admin_org AS (
    SELECT om_admin.organization_id AS admin_org_id
    FROM   public.organization_memberships AS om_admin
    JOIN   caller c ON c.caller_user_id = om_admin.user_id
    WHERE  om_admin.role::text = 'admin'
    LIMIT  1
  ),
  enabled_org AS (
    SELECT ao.admin_org_id
    FROM   admin_org ao
    WHERE  public.is_user_activity_insights_enabled(ao.admin_org_id)
  ),
  params AS (
    SELECT
      current_date                              AS today_date,
      ((p_end_date - p_start_date) + 1)::integer AS range_days
  ),
  members AS (
    SELECT
      om_member.user_id              AS member_user_id,
      p_member.name                  AS member_name,
      au_member.email                AS member_email,
      p_member.employee_id           AS member_employee_id,
      om_member.role::text           AS member_role
    FROM   enabled_org eo
    JOIN   public.organization_memberships AS om_member
           ON om_member.organization_id = eo.admin_org_id
    JOIN   public.profiles AS p_member
           ON p_member.user_id = om_member.user_id
    JOIN   auth.users AS au_member
           ON au_member.id = om_member.user_id
    WHERE  om_member.role::text <> 'master_admin'
  ),
  range_rollups AS (
    SELECT
      rollup.user_id                  AS rollup_user_id,
      rollup.activity_date            AS rollup_activity_date,
      rollup.visible_seconds          AS rollup_visible_seconds,
      rollup.expenses_submitted_count AS rollup_expenses_submitted_count,
      rollup.first_seen_at            AS rollup_first_seen_at,
      rollup.last_seen_at             AS rollup_last_seen_at
    FROM   enabled_org eo
    JOIN   public.user_activity_daily_rollups AS rollup
           ON rollup.organization_id = eo.admin_org_id
    WHERE  rollup.activity_date BETWEEN p_start_date AND p_end_date
  ),
  agg AS (
    SELECT
      rr.rollup_user_id                                  AS agg_user_id,
      MAX(rr.rollup_last_seen_at)                        AS agg_last_seen_at,
      MIN(rr.rollup_first_seen_at)                       AS agg_first_seen_in_range,
      COALESCE(SUM(rr.rollup_visible_seconds), 0)::integer
                                                         AS agg_total_visible_seconds,
      COALESCE(SUM(rr.rollup_expenses_submitted_count), 0)::integer
                                                         AS agg_total_expenses_submitted,
      COUNT(DISTINCT rr.rollup_activity_date)::integer   AS agg_active_days,
      MAX(rr.rollup_last_seen_at)                        AS agg_last_active_at
    FROM range_rollups rr
    GROUP BY rr.rollup_user_id
  ),
  today_agg AS (
    SELECT
      today_rollup.user_id                  AS today_user_id,
      today_rollup.visible_seconds          AS today_visible_seconds_value,
      today_rollup.expenses_submitted_count AS today_expenses_submitted_value
    FROM   enabled_org eo
    JOIN   params p ON true
    JOIN   public.user_activity_daily_rollups AS today_rollup
           ON today_rollup.organization_id = eo.admin_org_id
          AND today_rollup.activity_date   = p.today_date
  )
SELECT
  m.member_user_id                                           AS user_id,
  m.member_name                                              AS name,
  m.member_email                                             AS email,
  m.member_employee_id                                       AS employee_id,
  m.member_role                                              AS role,
  a.agg_last_seen_at                                         AS last_seen_at,
  a.agg_first_seen_in_range                                  AS first_seen_in_range,
  COALESCE(t.today_visible_seconds_value,    0)::integer     AS today_visible_seconds,
  COALESCE(t.today_expenses_submitted_value, 0)::integer     AS today_expenses_submitted,
  COALESCE(a.agg_active_days,                0)::integer     AS active_days,
  (p.range_days - COALESCE(a.agg_active_days, 0))::integer   AS inactive_days,
  CASE
    WHEN a.agg_last_active_at IS NULL THEN p.range_days
    ELSE (p_end_date - a.agg_last_active_at::date)
  END::integer                                               AS current_inactive_streak,
  COALESCE(a.agg_total_visible_seconds,      0)::integer     AS total_visible_seconds,
  COALESCE(a.agg_total_expenses_submitted,   0)::integer     AS total_expenses_submitted
FROM       members      m
CROSS JOIN params       p
LEFT JOIN  agg      a   ON a.agg_user_id   = m.member_user_id
LEFT JOIN  today_agg t  ON t.today_user_id = m.member_user_id
ORDER BY   COALESCE(a.agg_last_seen_at, '1970-01-01'::timestamptz) DESC;
$$;

COMMENT ON FUNCTION public.get_user_activity_summary IS
  'Returns one row per org member with activity stats for the date range. '
  'Set-based join on rollups — no per-user loops. Admin-only. '
  'Returns empty set when caller is unauthenticated, not admin, or feature disabled. '
  'Hotfix 03: role::text casts for app_role enum. '
  'Hotfix 04: CTE column renaming. '
  'Hotfix 05: rewritten as LANGUAGE sql to eliminate PL/pgSQL RETURNS TABLE '
  'output-variable ambiguity (SQLSTATE 42702) entirely.';


-- ============================================================
-- D12. RPC: get_user_activity_timeline
-- Admin-only. Returns one row per date in range with zero-fills.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_activity_timeline(
  p_user_id    uuid,
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  activity_date            date,
  visible_seconds          integer,
  session_count            integer,
  expenses_submitted_count integer,
  first_seen_at            timestamptz,
  last_seen_at             timestamptz,
  is_active                boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid;
  v_org_id    uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Caller must be admin of org that the target user belongs to
  -- role::text cast prevents app_role enum comparison error (Hotfix 03 pattern)
  SELECT om_caller.organization_id
  INTO   v_org_id
  FROM   public.organization_memberships om_caller
  JOIN   public.organization_memberships om_target
         ON  om_target.organization_id = om_caller.organization_id
         AND om_target.user_id         = p_user_id
  WHERE  om_caller.user_id       = v_caller_id
    AND  om_caller.role::text    = 'admin'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized'
      USING HINT = 'Caller must be an admin in the same org as the target user.';
  END IF;

  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN; -- empty result set
  END IF;

  RETURN QUERY
  SELECT
    d.day::date                                          AS activity_date,
    COALESCE(r.visible_seconds,          0)::integer    AS visible_seconds,
    COALESCE(r.session_count,            0)::integer    AS session_count,
    COALESCE(r.expenses_submitted_count, 0)::integer    AS expenses_submitted_count,
    r.first_seen_at,
    r.last_seen_at,
    (r.user_id IS NOT NULL)                             AS is_active
  FROM   generate_series(p_start_date, p_end_date, '1 day'::interval) AS d(day)
  LEFT JOIN public.user_activity_daily_rollups r
         ON  r.organization_id = v_org_id
         AND r.user_id         = p_user_id
         AND r.activity_date   = d.day::date
  ORDER  BY d.day ASC;
END;
$$;

COMMENT ON FUNCTION public.get_user_activity_timeline IS
  'Returns one row per calendar day in range (zero-filled for inactive days) '
  'for a specific user. Admin-only; validates same-org membership.';


-- ============================================================
-- D13. RPC: get_user_activity_detail
-- Admin-only. Returns individual sessions for a user in a range.
-- Used only when opening a specific session detail — not for table.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_user_activity_detail(
  p_user_id    uuid,
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE (
  id               uuid,
  started_at       timestamptz,
  ended_at         timestamptz,
  last_seen_at     timestamptz,
  visible_seconds  integer,
  heartbeat_count  integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id uuid;
  v_org_id    uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- role::text cast prevents app_role enum comparison error (Hotfix 03 pattern)
  SELECT om_caller.organization_id
  INTO   v_org_id
  FROM   public.organization_memberships om_caller
  JOIN   public.organization_memberships om_target
         ON  om_target.organization_id = om_caller.organization_id
         AND om_target.user_id         = p_user_id
  WHERE  om_caller.user_id       = v_caller_id
    AND  om_caller.role::text    = 'admin'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF NOT public.is_user_activity_insights_enabled(v_org_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT s.id,
         s.started_at,
         s.ended_at,
         s.last_seen_at,
         s.visible_seconds,
         s.heartbeat_count
  FROM   public.user_activity_sessions s
  WHERE  s.organization_id = v_org_id
    AND  s.user_id         = p_user_id
    AND  s.started_at::date BETWEEN p_start_date AND p_end_date
  ORDER  BY s.started_at DESC;
END;
$$;

COMMENT ON FUNCTION public.get_user_activity_detail IS
  'Returns raw session rows for a user in the date range. '
  'Admin-only. Not used for the summary table (use rollups instead).';


-- ============================================================
-- D14. Expense submission trigger
-- Increments expenses_submitted_count in daily rollups when an
-- expense row transitions to status = 'submitted'.
-- Does NOT alter the expense row or touch ExpenseService.
--
-- Feature-flag safety: if user_activity_insights is disabled for the
-- expense's organization the trigger returns immediately, leaving the
-- expense row and all other tables completely untouched.
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_user_activity_expense_submitted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_activity_date date;
BEGIN
  -- Feature gate: no-op entirely when feature is disabled for this org.
  -- Expense submission flow is not affected in any case.
  IF NOT public.is_user_activity_insights_enabled(NEW.organization_id) THEN
    RETURN NEW;
  END IF;

  -- Only care about transitions INTO 'submitted'
  IF NEW.status = 'submitted'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'submitted')
  THEN
    v_activity_date := COALESCE(NEW.updated_at, now())::date;

    INSERT INTO public.user_activity_daily_rollups
      (organization_id, user_id, activity_date, expenses_submitted_count, last_seen_at)
    VALUES
      (NEW.organization_id, NEW.user_id, v_activity_date, 1, COALESCE(NEW.updated_at, now()))
    ON CONFLICT (organization_id, user_id, activity_date) DO UPDATE
      SET expenses_submitted_count =
            user_activity_daily_rollups.expenses_submitted_count + 1,
          last_seen_at =
            GREATEST(user_activity_daily_rollups.last_seen_at, EXCLUDED.last_seen_at),
          updated_at   = now();
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_user_activity_expense_submitted IS
  'Trigger function: increments expenses_submitted_count rollup when an '
  'expense becomes submitted. No-ops entirely when feature is disabled — '
  'expense submission flow is not touched in any case.';

-- Drop before create so this migration is re-runnable
DROP TRIGGER IF EXISTS trg_user_activity_expense_submitted
  ON public.expenses;

CREATE TRIGGER trg_user_activity_expense_submitted
  AFTER INSERT OR UPDATE OF status
  ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_user_activity_expense_submitted();

COMMENT ON TRIGGER trg_user_activity_expense_submitted ON public.expenses IS
  'Fires after INSERT or status UPDATE on expenses. Increments '
  'user_activity_daily_rollups.expenses_submitted_count for submitted expenses.';
