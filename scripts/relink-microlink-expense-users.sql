-- Relink expenses to CURRENT Microlink employee profiles after bulk user delete/re-import.
--
-- Problem: remove-org-employees deleted profiles but kept auth.users + expenses.
--          Re-import created NEW auth users (new user_id) for the same employee_id.
--          Admin panel shows "Unknown User" because expenses.user_id is stale.
--
-- Org: 6709c1fe-e8c8-404d-bc68-d1edda923344
--
-- Run STEP 1 preview first. If rows look right, run STEP 2 update.

-- =============================================================================
-- STEP 1 — Preview orphaned expenses and proposed new user_id
-- =============================================================================
WITH orphan_expenses AS (
  SELECT e.id AS expense_id, e.user_id AS old_user_id, e.title, e.status
  FROM public.expenses e
  WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = e.user_id
        AND p.organization_id = e.organization_id
    )
),
orphan_auth AS (
  SELECT
    oe.*,
    au.email AS old_auth_email,
    lower(
      substring(au.email from 'emp\.[^.]+\.([^.]+)\.')
    ) AS employee_id_from_email
  FROM orphan_expenses oe
  LEFT JOIN auth.users au ON au.id = oe.old_user_id
),
current_employee AS (
  SELECT
    lower(trim(p.employee_id)) AS employee_id,
    p.user_id AS new_user_id,
    p.name,
    p.email
  FROM public.profiles p
  JOIN public.organization_memberships om
    ON om.user_id = p.user_id
   AND om.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
   AND om.is_active = true
  WHERE p.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
    AND p.employee_id IS NOT NULL
    AND trim(p.employee_id) <> ''
)
SELECT
  oa.expense_id,
  oa.title,
  oa.status,
  oa.old_user_id,
  oa.old_auth_email,
  oa.employee_id_from_email,
  ce.new_user_id,
  ce.name AS new_employee_name,
  ce.email AS new_profile_email,
  CASE
    WHEN ce.new_user_id IS NULL THEN 'NO MATCH — fix manually'
    ELSE 'OK'
  END AS relink_status
FROM orphan_auth oa
LEFT JOIN current_employee ce ON ce.employee_id = oa.employee_id_from_email
ORDER BY oa.status, oa.title;

-- =============================================================================
-- STEP 2 — Apply relink (uncomment and run after preview looks good)
-- =============================================================================
/*
BEGIN;

WITH orphan_expenses AS (
  SELECT e.id AS expense_id, e.user_id AS old_user_id
  FROM public.expenses e
  WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
    AND NOT EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = e.user_id
        AND p.organization_id = e.organization_id
    )
),
orphan_auth AS (
  SELECT
    oe.expense_id,
    lower(substring(au.email from 'emp\.[^.]+\.([^.]+)\.')) AS employee_id_from_email
  FROM orphan_expenses oe
  JOIN auth.users au ON au.id = oe.old_user_id
  WHERE au.email ~ 'emp\.[^.]+\.[^.]+\.'
),
current_employee AS (
  SELECT
    lower(trim(p.employee_id)) AS employee_id,
    p.user_id AS new_user_id
  FROM public.profiles p
  JOIN public.organization_memberships om
    ON om.user_id = p.user_id
   AND om.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
   AND om.is_active = true
  WHERE p.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
    AND p.employee_id IS NOT NULL
)
UPDATE public.expenses e
SET
  user_id = ce.new_user_id,
  updated_at = now()
FROM orphan_auth oa
JOIN current_employee ce ON ce.employee_id = oa.employee_id_from_email
WHERE e.id = oa.expense_id;

COMMIT;
*/

-- =============================================================================
-- STEP 3 — Verify (should return 0 orphaned after relink)
-- =============================================================================
SELECT count(*) AS orphaned_expenses_still_missing_profile
FROM public.expenses e
WHERE e.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'::uuid
  AND NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.user_id = e.user_id
      AND p.organization_id = e.organization_id
  );
