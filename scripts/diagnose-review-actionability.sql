-- Review Expenses — bulk-selection root-cause diagnostic (READ ONLY).
-- Safe to run on production: no writes, wrapped in a read-only transaction.
-- Reproduces the exact server actionability contract for the screenshot rows
-- and the KPI distribution, WITHOUT relying on auth.uid() (psql is superuser),
-- by passing the caller's role/id explicitly into the canonical helper.
--
-- Set the two variables below before running, or edit inline.
--   :org_slug  MicroLink's organization slug or name fragment
--   (the owner user_id is auto-discovered from the admin/executive membership)

BEGIN;
SET TRANSACTION READ ONLY;

-- 0) Resolve the organization ------------------------------------------------
WITH org AS (
  SELECT id, name, slug
  FROM public.organizations
  WHERE name ILIKE '%microlink%' OR slug ILIKE '%microlink%'
  LIMIT 1
)
SELECT 'organization' AS section, id::text, name, slug FROM org;

-- 1) Who are the candidate reviewers (role that gives broad scope)? -----------
WITH org AS (
  SELECT id FROM public.organizations
  WHERE name ILIKE '%microlink%' OR slug ILIKE '%microlink%' LIMIT 1
)
SELECT 'memberships' AS section, m.user_id::text, m.role::text, m.is_active
FROM public.organization_memberships m, org
WHERE m.organization_id = org.id
  AND m.role::text IN ('admin','executive','team_leader')
ORDER BY m.role;

-- 2) Organization hierarchy feature flags (verify read-only, DO NOT change) ---
WITH org AS (
  SELECT id FROM public.organizations
  WHERE name ILIKE '%microlink%' OR slug ILIKE '%microlink%' LIMIT 1
)
SELECT 'features' AS section, f.feature_key, f.enabled
FROM public.organization_features f, org
WHERE f.organization_id = org.id
  AND f.feature_key IN ('approval_hierarchy','hierarchy_team_leader','hierarchy_executive');

-- 3) The exact screenshot rows: raw authorization inputs ----------------------
WITH org AS (
  SELECT id FROM public.organizations
  WHERE name ILIKE '%microlink%' OR slug ILIKE '%microlink%' LIMIT 1
)
SELECT 'screenshot_rows' AS section,
       e.transaction_number,
       e.status::text,
       e.approval_tier,
       (e.batch_id IS NOT NULL)                       AS is_batch,
       (e.assigned_reviewer_id IS NOT NULL)           AS has_reviewer,
       (e.assigned_engineer_id IS NOT NULL)           AS has_engineer
FROM public.expenses e, org
WHERE e.organization_id = org.id
  AND e.transaction_number IN ('10485','10484','10483','10489','10488')
ORDER BY e.transaction_number;

-- 4) Reproduce actionability for the screenshot rows AS THE OWNER -------------
--    Uses the real membership role + user_id; no auth.uid() needed.
WITH org AS (
  SELECT id FROM public.organizations
  WHERE name ILIKE '%microlink%' OR slug ILIKE '%microlink%' LIMIT 1
),
caller AS (
  SELECT m.user_id, m.role::text AS role
  FROM public.organization_memberships m, org
  WHERE m.organization_id = org.id AND m.is_active
    AND m.role::text IN ('admin','executive','team_leader')
  ORDER BY CASE m.role::text WHEN 'admin' THEN 0 WHEN 'executive' THEN 1 ELSE 2 END
  LIMIT 1
),
flags AS (
  SELECT
    coalesce(bool_or(f.feature_key='approval_hierarchy'    AND f.enabled),false) AS hier,
    coalesce(bool_or(f.feature_key='hierarchy_team_leader' AND f.enabled),false) AS tl,
    coalesce(bool_or(f.feature_key='hierarchy_executive'   AND f.enabled),false) AS ex
  FROM public.organization_features f, org
  WHERE f.organization_id = org.id
)
SELECT 'actionability_for_owner' AS section,
       c.role AS caller_role,
       e.transaction_number,
       e.status::text,
       e.approval_tier,
       act->>'is_actionable'    AS is_actionable,
       act->>'actionable_reason' AS actionable_reason,
       act->'available_actions' AS available_actions,
       act->>'view_only'        AS view_only
FROM public.expenses e, org, caller c, flags fl
CROSS JOIN LATERAL public._debug_review_actionability_v1(
  c.role, c.user_id,
  e.status::text, e.approval_tier,
  e.assigned_reviewer_id, e.assigned_engineer_id,
  fl.hier, fl.hier AND fl.tl, fl.hier AND fl.ex,
  false  -- handoff not modelled here; screenshot rows are 'submitted'
) AS act
WHERE e.organization_id = org.id
  AND e.transaction_number IN ('10485','10484','10483')
ORDER BY e.transaction_number;

-- 5) KPI distribution: WHY is actionable_now ~1 of ~9122 pending? -------------
--    Buckets the pending population by approval_tier and the reason the owner
--    cannot act, using the same canonical helper.
WITH org AS (
  SELECT id FROM public.organizations
  WHERE name ILIKE '%microlink%' OR slug ILIKE '%microlink%' LIMIT 1
),
caller AS (
  SELECT m.user_id, m.role::text AS role
  FROM public.organization_memberships m, org
  WHERE m.organization_id = org.id AND m.is_active
    AND m.role::text IN ('admin','executive','team_leader')
  ORDER BY CASE m.role::text WHEN 'admin' THEN 0 WHEN 'executive' THEN 1 ELSE 2 END
  LIMIT 1
),
flags AS (
  SELECT
    coalesce(bool_or(f.feature_key='approval_hierarchy'    AND f.enabled),false) AS hier,
    coalesce(bool_or(f.feature_key='hierarchy_team_leader' AND f.enabled),false) AS tl,
    coalesce(bool_or(f.feature_key='hierarchy_executive'   AND f.enabled),false) AS ex
  FROM public.organization_features f, org
  WHERE f.organization_id = org.id
),
pending AS (
  SELECT e.approval_tier,
         act->>'is_actionable'     AS is_actionable,
         act->>'actionable_reason' AS actionable_reason
  FROM public.expenses e, org, caller c, flags fl
  CROSS JOIN LATERAL public._debug_review_actionability_v1(
    c.role, c.user_id, e.status::text, e.approval_tier,
    e.assigned_reviewer_id, e.assigned_engineer_id,
    fl.hier, fl.hier AND fl.tl, fl.hier AND fl.ex, false
  ) AS act
  WHERE e.organization_id = org.id
    AND e.status::text IN ('submitted','edited','under_review','level_1_verified','level_2_verified')
)
SELECT 'kpi_distribution' AS section,
       coalesce(approval_tier,'(null)') AS approval_tier,
       actionable_reason,
       count(*) AS n
FROM pending
GROUP BY approval_tier, actionable_reason
ORDER BY n DESC;

COMMIT;
