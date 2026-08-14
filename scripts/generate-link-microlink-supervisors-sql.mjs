#!/usr/bin/env node
/**
 * Generates SQL to assign Microlink employees to their executives (5022 / 3542)
 * using immediate_supervisor_employee_id from an operator-supplied TSV.
 *
 * The employee file is NEVER tracked. Supply it at runtime:
 *   node scripts/generate-link-microlink-supervisors-sql.mjs --input <path>
 * See Documentations MD/sensitive-local-data-policy.md.
 *
 * Then run the output SQL in Supabase (dry-run SELECT first).
 */
import fs from "fs";
import path from "path";
import {
  loadEmployeeRows,
  parseArgs,
  resolveOutputPath,
} from "./lib/employeeDataInput.mjs";

import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORG_ID = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const args = parseArgs();
const outPath = resolveOutputPath(args, "link-microlink-employee-supervisors.sql");

const { rows: employeeRows } = loadEmployeeRows(args, {
  requiredColumns: ["employee_id"],
});
// Column validation lives in the shared loader, which also rejects any
// credential column before a value reaches memory.
const pairs = employeeRows
  .filter((row) => row.employee_id && row.immediate_supervisor_employee_id)
  .map((row) => ({
    employeeId: row.employee_id,
    supervisorId: row.immediate_supervisor_employee_id,
  }));

const valuesSql = pairs
  .map(
    (p) =>
      `  ('${p.employeeId.replace(/'/g, "''")}', '${p.supervisorId.replace(/'/g, "''")}')`,
  )
  .join(",\n");

const sql = `-- Link Microlink employees to executives via employee_id (generated ${new Date().toISOString().slice(0, 10)})
-- Org: ${ORG_ID}
-- Rows: ${pairs.length}
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
${valuesSql};

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
  ON emp.organization_id = '${ORG_ID}'
 AND lower(trim(emp.employee_id)) = lower(trim(m.employee_id))
LEFT JOIN profiles sup
  ON sup.organization_id = '${ORG_ID}'
 AND lower(trim(sup.employee_id)) = lower(trim(m.supervisor_employee_id))
LEFT JOIN organization_memberships om_sup
  ON om_sup.user_id = sup.user_id
 AND om_sup.organization_id = '${ORG_ID}'
 AND om_sup.is_active = true
WHERE emp.user_id IS NULL OR sup.user_id IS NULL OR om_sup.role NOT IN ('executive', 'team_leader', 'engineer');

-- Apply links (employees only)
UPDATE profiles AS p
SET reporting_engineer_id = sup.user_id
FROM microlink_supervisor_map m
JOIN profiles AS emp
  ON emp.organization_id = '${ORG_ID}'
 AND lower(trim(emp.employee_id)) = lower(trim(m.employee_id))
JOIN profiles AS sup
  ON sup.organization_id = '${ORG_ID}'
 AND lower(trim(sup.employee_id)) = lower(trim(m.supervisor_employee_id))
JOIN organization_memberships om_emp
  ON om_emp.user_id = emp.user_id
 AND om_emp.organization_id = '${ORG_ID}'
 AND om_emp.is_active = true
 AND om_emp.role = 'employee'
JOIN organization_memberships om_sup
  ON om_sup.user_id = sup.user_id
 AND om_sup.organization_id = '${ORG_ID}'
 AND om_sup.is_active = true
 AND om_sup.role IN ('executive', 'team_leader', 'engineer')
WHERE p.user_id = emp.user_id
  AND p.organization_id = '${ORG_ID}';

COMMIT;

-- Verify: unassigned employees
SELECT count(*) AS unassigned_employees
FROM profiles p
JOIN organization_memberships om
  ON om.user_id = p.user_id
 AND om.organization_id = '${ORG_ID}'
 AND om.is_active = true
WHERE om.role = 'employee'
  AND p.reporting_engineer_id IS NULL;
`;

fs.writeFileSync(outPath, sql, "utf8");
console.log(`Wrote ${outPath} (${pairs.length} employee→supervisor mappings)`);
