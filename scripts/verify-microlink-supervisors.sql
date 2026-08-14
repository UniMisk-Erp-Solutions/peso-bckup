-- Microlink hierarchy checks (org 6709c1fe-e8c8-404d-bc68-d1edda923344)
-- Chain: employee → executive → engineer (manager) → admin

-- A) Executives referenced as supervisors in import (5022, 3542)
SELECT
  p.employee_id,
  p.name,
  au.email,
  om.role,
  p.reporting_engineer_id,
  mgr.name AS reports_to_manager,
  mgr.employee_id AS manager_employee_id
FROM profiles p
JOIN organization_memberships om
  ON om.user_id = p.user_id
 AND om.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND om.is_active = true
LEFT JOIN auth.users au ON au.id = p.user_id
LEFT JOIN profiles mgr ON mgr.user_id = p.reporting_engineer_id
WHERE lower(trim(p.employee_id)) IN ('5022', '3542')
ORDER BY p.employee_id;

-- B) If role is NOT executive, fix it (only if they should be executives):
-- UPDATE organization_memberships SET role = 'executive'
-- WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
--   AND user_id IN (SELECT user_id FROM profiles WHERE lower(trim(employee_id)) IN ('5022','3542'));

-- C) Feature flags (executive tier must be ON for executive supervisors)
SELECT feature_key, enabled
FROM organization_features
WHERE organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND feature_key IN ('approval_hierarchy', 'hierarchy_executive', 'hierarchy_team_leader', 'employee_id_login');

-- D) Employees missing immediate supervisor (should be 0 after link SQL)
SELECT p.employee_id, p.name, p.email
FROM profiles p
JOIN organization_memberships om
  ON om.user_id = p.user_id
 AND om.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND om.is_active = true
WHERE om.role = 'employee'
  AND p.reporting_engineer_id IS NULL
ORDER BY p.name
LIMIT 50;

-- E) Sample: employees linked to executive 5022
SELECT
  emp.employee_id,
  emp.name,
  sup.employee_id AS supervisor_employee_id,
  sup.name AS supervisor_name,
  om_sup.role AS supervisor_role
FROM profiles emp
JOIN organization_memberships om_emp
  ON om_emp.user_id = emp.user_id
 AND om_emp.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND om_emp.role = 'employee'
JOIN profiles sup ON sup.user_id = emp.reporting_engineer_id
JOIN organization_memberships om_sup
  ON om_sup.user_id = sup.user_id
 AND om_sup.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
WHERE emp.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
  AND lower(trim(sup.employee_id)) = '5022'
LIMIT 20;
