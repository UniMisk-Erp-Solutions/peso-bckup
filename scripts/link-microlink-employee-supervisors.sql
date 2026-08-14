-- Link Microlink employees to executives via employee_id (generated 2026-06-17)
-- Org: 6709c1fe-e8c8-404d-bc68-d1edda923344
-- Rows: 208
--
-- PREVIEW (run first):
-- SELECT * FROM (... mapping ...) m
-- LEFT JOIN profiles emp ON ...
--
-- REQUIREMENTS:
-- 1. Users with employee_id 5022 and 3542 must exist with role executive (or engineer).
-- 2. hierarchy_executive must be ON for executive supervisors (Master Admin).
-- 3. Executives must report to a manager (engineer) to appear in location hierarchy tree.

BEGIN;

CREATE TEMP TABLE microlink_supervisor_map (
  employee_id text NOT NULL,
  supervisor_employee_id text NOT NULL
) ON COMMIT DROP;

INSERT INTO microlink_supervisor_map (employee_id, supervisor_employee_id) VALUES
  ('5002', '5022'),
  ('5003', '5022'),
  ('5005', '5022'),
  ('5011', '5022'),
  ('5018', '5022'),
  ('5019', '5022'),
  ('5020', '5022'),
  ('5024', '5022'),
  ('5026', '5022'),
  ('5035', '5022'),
  ('5043', '5022'),
  ('5071', '5022'),
  ('5077', '5022'),
  ('5140', '5022'),
  ('5145', '5022'),
  ('5146', '5022'),
  ('5168', '5022'),
  ('5178', '5022'),
  ('5213', '5022'),
  ('5243', '5022'),
  ('5262', '5022'),
  ('5292', '5022'),
  ('5329', '5022'),
  ('5356', '5022'),
  ('5367', '5022'),
  ('5430', '5022'),
  ('5437', '5022'),
  ('5476', '5022'),
  ('5540', '5022'),
  ('5565', '5022'),
  ('5666', '5022'),
  ('5740', '5022'),
  ('5759', '5022'),
  ('5763', '5022'),
  ('5819', '5022'),
  ('5944', '5022'),
  ('5978', '5022'),
  ('6007', '5022'),
  ('6060', '5022'),
  ('6101', '5022'),
  ('6118', '5022'),
  ('6167', '5022'),
  ('6174', '5022'),
  ('6195', '5022'),
  ('6196', '5022'),
  ('6203', '5022'),
  ('6205', '5022'),
  ('6206', '5022'),
  ('6215', '5022'),
  ('6223', '5022'),
  ('6228', '5022'),
  ('6236', '5022'),
  ('6238', '5022'),
  ('6245', '5022'),
  ('6291', '5022'),
  ('6309', '5022'),
  ('6330', '5022'),
  ('6333', '5022'),
  ('6349', '5022'),
  ('6353', '5022'),
  ('6356', '5022'),
  ('6375', '5022'),
  ('6380', '5022'),
  ('6387', '5022'),
  ('6431', '5022'),
  ('6421', '5022'),
  ('6432', '5022'),
  ('6444', '5022'),
  ('6446', '5022'),
  ('6465', '5022'),
  ('6466', '5022'),
  ('6488', '5022'),
  ('6490', '5022'),
  ('6498', '5022'),
  ('6501', '5022'),
  ('6510', '5022'),
  ('6517', '5022'),
  ('6519', '5022'),
  ('6526', '5022'),
  ('6541', '5022'),
  ('6568', '5022'),
  ('6571', '5022'),
  ('6585', '5022'),
  ('6595', '5022'),
  ('6597', '5022'),
  ('6598', '5022'),
  ('6543', '5022'),
  ('6544', '5022'),
  ('6546', '5022'),
  ('6549', '5022'),
  ('6551', '5022'),
  ('6552', '5022'),
  ('6555', '5022'),
  ('6557', '5022'),
  ('6603', '5022'),
  ('6611', '5022'),
  ('6614', '5022'),
  ('6616', '5022'),
  ('6622', '5022'),
  ('6623', '5022'),
  ('6625', '5022'),
  ('6631', '5022'),
  ('6634', '5022'),
  ('6638', '5022'),
  ('6646', '5022'),
  ('6654', '5022'),
  ('6657', '5022'),
  ('6658', '5022'),
  ('6659', '5022'),
  ('6660', '5022'),
  ('6664', '5022'),
  ('6669', '5022'),
  ('6686', '5022'),
  ('6687', '5022'),
  ('6688', '5022'),
  ('6691', '5022'),
  ('6692', '5022'),
  ('6693', '5022'),
  ('6694', '5022'),
  ('6697', '5022'),
  ('6698', '5022'),
  ('6701', '5022'),
  ('6710', '5022'),
  ('6711', '5022'),
  ('6713', '5022'),
  ('6716', '5022'),
  ('6721', '5022'),
  ('6731', '5022'),
  ('6736', '5022'),
  ('6738', '5022'),
  ('6740', '5022'),
  ('6741', '5022'),
  ('6744', '5022'),
  ('6745', '5022'),
  ('6754', '5022'),
  ('6755', '5022'),
  ('6756', '5022'),
  ('6757', '5022'),
  ('6759', '5022'),
  ('6762', '5022'),
  ('6765', '5022'),
  ('6767', '5022'),
  ('6772', '5022'),
  ('6781', '5022'),
  ('6784', '5022'),
  ('6783', '5022'),
  ('6792', '5022'),
  ('6796', '5022'),
  ('6797', '5022'),
  ('6805', '5022'),
  ('6809', '5022'),
  ('6813', '5022'),
  ('6814', '5022'),
  ('6815', '5022'),
  ('6816', '5022'),
  ('6818', '5022'),
  ('6820', '5022'),
  ('6821', '5022'),
  ('6822', '5022'),
  ('6823', '5022'),
  ('6824', '5022'),
  ('6825', '5022'),
  ('6826', '5022'),
  ('6828', '5022'),
  ('6829', '5022'),
  ('6830', '5022'),
  ('6831', '5022'),
  ('6832', '5022'),
  ('6833', '5022'),
  ('6838', '5022'),
  ('6840', '5022'),
  ('6842', '5022'),
  ('6844', '5022'),
  ('6846', '5022'),
  ('6847', '5022'),
  ('6849', '5022'),
  ('6850', '5022'),
  ('6852', '5022'),
  ('6855', '5022'),
  ('6857', '5022'),
  ('6860', '5022'),
  ('6861', '5022'),
  ('6865', '5022'),
  ('6760', '5022'),
  ('6787', '5022'),
  ('6873', '5022'),
  ('6874', '5022'),
  ('6876', '5022'),
  ('6877', '5022'),
  ('6878', '5022'),
  ('6883', '5022'),
  ('6885', '5022'),
  ('6887', '5022'),
  ('6890', '5022'),
  ('6891', '5022'),
  ('6896', '5022'),
  ('6897', '5022'),
  ('6898', '5022'),
  ('6900', '5022'),
  ('6901', '5022'),
  ('6904', '5022'),
  ('6905', '5022'),
  ('6906', '5022'),
  ('6907', '5022'),
  ('6908', '5022'),
  ('6909', '5022'),
  ('3884', '3542'),
  ('3762', '3542');

-- Preview unresolved rows
SELECT
  m.employee_id,
  m.supervisor_employee_id,
  emp.user_id AS employee_user_id,
  emp.name AS employee_name,
  sup.user_id AS supervisor_user_id,
  sup.name AS supervisor_name,
  om_sup.role AS supervisor_role
FROM microlink_supervisor_map m
LEFT JOIN profiles emp
  ON emp.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND lower(trim(emp.employee_id)) = lower(trim(m.employee_id))
LEFT JOIN profiles sup
  ON sup.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND lower(trim(sup.employee_id)) = lower(trim(m.supervisor_employee_id))
LEFT JOIN organization_memberships om_sup
  ON om_sup.user_id = sup.user_id
 AND om_sup.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND om_sup.is_active = true
WHERE emp.user_id IS NULL OR sup.user_id IS NULL OR om_sup.role NOT IN ('executive', 'team_leader', 'engineer');

-- Apply links (employees only)
UPDATE profiles AS p
SET reporting_engineer_id = sup.user_id
FROM microlink_supervisor_map m
JOIN profiles AS emp
  ON emp.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND lower(trim(emp.employee_id)) = lower(trim(m.employee_id))
JOIN profiles AS sup
  ON sup.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND lower(trim(sup.employee_id)) = lower(trim(m.supervisor_employee_id))
JOIN organization_memberships om_emp
  ON om_emp.user_id = emp.user_id
 AND om_emp.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND om_emp.is_active = true
 AND om_emp.role = 'employee'
JOIN organization_memberships om_sup
  ON om_sup.user_id = sup.user_id
 AND om_sup.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND om_sup.is_active = true
 AND om_sup.role IN ('executive', 'team_leader', 'engineer')
WHERE p.user_id = emp.user_id
  AND p.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344';

COMMIT;

-- Verify: unassigned employees
SELECT count(*) AS unassigned_employees
FROM profiles p
JOIN organization_memberships om
  ON om.user_id = p.user_id
 AND om.organization_id = '6709c1fe-e8c8-404d-bc68-d1edda923344'
 AND om.is_active = true
WHERE om.role = 'employee'
  AND p.reporting_engineer_id IS NULL;
