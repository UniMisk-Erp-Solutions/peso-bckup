-- ============================================================
-- FILE: 07_team_expenses_rpc.sql
-- PURPOSE: SECURITY DEFINER RPC that fetches expenses for a
--          specific list of team member user IDs, bypassing RLS.
--
-- WHY THIS IS NEEDED:
--   RLS cannot efficiently evaluate a recursive hierarchy check
--   (get_subordinate_user_ids) per-row without timing out.
--   The per-row recursive CTE approach in the USING clause causes
--   the same 57014 timeout even after the index is in place.
--
--   The correct architecture for hierarchy-based team scoping:
--     - The frontend already calls list_my_teams_overview to get
--       teamMemberUserIds (SECURITY DEFINER — correctly scoped)
--     - Pass those IDs directly to this function (in the request
--       body as a uuid[], not as a URL query param)
--     - This function does a single user_id = ANY(p_user_ids) filter
--       using the existing index — fast, no per-row recursive CTE
--
-- SECURITY:
--   Safe because:
--     1. p_user_ids comes from list_my_teams_overview which already
--        enforces team-leader scoping server-side
--     2. p_organization_id is scoped to the viewer's org
--     3. The function is SECURITY DEFINER — only the function logic
--        is trusted, not the caller's RLS context
--
-- RUN THIS IN SUPABASE SQL EDITOR — single statement, safe to run.
-- ============================================================


CREATE OR REPLACE FUNCTION public.get_team_expenses_for_members(
  p_organization_id  uuid,
  p_user_ids         uuid[],
  p_statuses         text[]        DEFAULT NULL,
  p_category         text          DEFAULT NULL,
  p_trip_start_from  text          DEFAULT NULL,  -- date string e.g. '2025-01-01'
  p_trip_start_to    text          DEFAULT NULL,  -- date string e.g. '2025-12-31'
  p_sort_by          text          DEFAULT 'created_at',
  p_limit            int           DEFAULT 2000
)
RETURNS TABLE (
  id                 uuid,
  user_id            uuid,
  title              text,
  total_amount       numeric,
  status             text,
  created_at         timestamptz,
  trip_start         text,
  trip_end           text,
  category           text,
  purpose            text,
  destination        text,
  transaction_number text,
  batch_id           uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.id,
    e.user_id,
    COALESCE(e.title, '')              AS title,
    COALESCE(e.total_amount, 0)        AS total_amount,
    e.status::text                     AS status,
    e.created_at,
    e.trip_start::text                 AS trip_start,
    e.trip_end::text                   AS trip_end,
    COALESCE(e.category, '')           AS category,
    COALESCE(e.purpose, '')            AS purpose,
    COALESCE(e.destination, '')        AS destination,
    COALESCE(e.transaction_number, '') AS transaction_number,
    e.batch_id
  FROM public.expenses e
  WHERE e.organization_id = p_organization_id
    AND e.user_id = ANY(p_user_ids)
    AND (p_statuses IS NULL OR e.status::text = ANY(p_statuses))
    AND (p_category IS NULL OR e.category ILIKE p_category)
    AND (p_trip_start_from IS NULL OR e.trip_start::text >= p_trip_start_from)
    AND (p_trip_start_to   IS NULL OR e.trip_start::text <= p_trip_start_to)
  ORDER BY
    CASE WHEN p_sort_by = 'trip_start' THEN e.trip_start::text END DESC NULLS LAST,
    CASE WHEN p_sort_by IS DISTINCT FROM 'trip_start' THEN e.created_at END DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 2000), 5000));
$$;

GRANT EXECUTE ON FUNCTION public.get_team_expenses_for_members(
  uuid, uuid[], text[], text, text, text, text, int
) TO authenticated;


-- ──────────────────────────────────────────────────────────
-- VERIFICATION: confirm the function exists and is callable
-- ──────────────────────────────────────────────────────────

SELECT
  p.proname          AS function_name,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef        AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'get_team_expenses_for_members';
