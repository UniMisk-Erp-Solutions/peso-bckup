#!/usr/bin/env node
/**
 * Reads an operator-supplied employee TSV and writes removal SQL.
 *
 * Run: node scripts/generate-remove-org-employees-sql.mjs --input <path> --confirm
 * The input is never tracked; see Documentations MD/sensitive-local-data-policy.md.
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
const excludePath = path.join(__dirname, "data", "microlink-missing-employee-ids.txt");
const args = parseArgs();
const outPath = resolveOutputPath(args, "remove-org-employees.sql");

const exclude = new Set(
  fs
    .readFileSync(excludePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean),
);

const { rows: employeeRows } = loadEmployeeRows(args, {
  requiredColumns: ["employee_id"],
});
// The loader validates columns and rejects credential fields. This tool no
// longer rewrites its own input: reading operator data and writing back to it
// is not its business, and it is how a working file became a tracked one.
const ids = [];
let skipped = 0;
for (const row of employeeRows) {
  const id = row.employee_id;
  if (!id) continue;
  if (exclude.has(id.toLowerCase())) {
    skipped += 1;
    continue;
  }
  ids.push(id);
}


const unique = [...new Set(ids)];
const arrayLiteral = unique.map((id) => `'${id.replace(/'/g, "''")}'`).join(",\n  ");

const sql = `-- Remove bulk-imported employees from Microlink org by employee_id.
-- Organization: ${ORG_ID}
-- Source list: operator-supplied input (${unique.length} employee IDs)
-- Excluded ${skipped} ID(s) with no user in org — see scripts/data/microlink-missing-employee-ids.txt
--
-- Run in Supabase SQL Editor (Coolify) as postgres / service role.
-- STEP 1: Run the PREVIEW block only and confirm the user list.
-- STEP 2: Uncomment COMMIT section (or run the DO block) to delete.

-- =============================================================================
-- PREVIEW (safe — read only)
-- =============================================================================
WITH target_ids AS (
  SELECT unnest(ARRAY[
  ${arrayLiteral}
  ]::text[]) AS employee_id
),
matched AS (
  SELECT
    p.user_id,
    p.name,
    p.email,
    p.employee_id,
    om.role,
    om.is_active AS membership_active
  FROM public.organization_memberships om
  INNER JOIN public.profiles p ON p.user_id = om.user_id
  INNER JOIN target_ids t ON lower(trim(p.employee_id)) = lower(trim(t.employee_id))
  WHERE om.organization_id = '${ORG_ID}'::uuid
    AND om.role = 'employee'
)
SELECT * FROM matched ORDER BY employee_id;

SELECT
  (SELECT COUNT(*) FROM (
    SELECT unnest(ARRAY[
  ${arrayLiteral}
    ]::text[]) AS employee_id
  ) t) AS ids_in_list,
  (SELECT COUNT(DISTINCT om.user_id)
   FROM public.organization_memberships om
   INNER JOIN public.profiles p ON p.user_id = om.user_id
   WHERE om.organization_id = '${ORG_ID}'::uuid
    AND om.role = 'employee'
     AND lower(trim(p.employee_id)) IN (
       SELECT lower(trim(x)) FROM unnest(ARRAY[
  ${arrayLiteral}
       ]::text[]) AS x
     )
  ) AS profiles_matched_in_org;

-- =============================================================================
-- DEACTIVATE (soft remove — keeps profiles + all expense/audit history)
-- Set dry_run := false to apply.
-- =============================================================================
DO $$
DECLARE
  target_org_id UUID := '${ORG_ID}';
  dry_run BOOLEAN := true;
  emp_ids TEXT[] := ARRAY[
  ${arrayLiteral}
  ];
  user_ids UUID[];
  n_memberships INTEGER;
  n_profiles INTEGER;
  uid UUID;
BEGIN
  SELECT ARRAY_AGG(DISTINCT om.user_id)
  INTO user_ids
  FROM public.organization_memberships om
  INNER JOIN public.profiles p ON p.user_id = om.user_id
  WHERE om.organization_id = target_org_id
    AND om.role = 'employee'
    AND lower(trim(p.employee_id)) = ANY (
      SELECT lower(trim(x)) FROM unnest(emp_ids) AS x
    );

  IF user_ids IS NULL OR array_length(user_ids, 1) IS NULL THEN
    RAISE NOTICE 'No matching profiles in org %', target_org_id;
    RETURN;
  END IF;

  RAISE NOTICE 'Matched % user(s) to deactivate', array_length(user_ids, 1);

  IF dry_run THEN
    RAISE NOTICE 'DRY RUN — set dry_run := false to apply deactivations';
    RETURN;
  END IF;

  UPDATE public.profiles
  SET
    reporting_engineer_id = NULL,
    assigned_cashier_id = NULL,
    cashier_assigned_engineer_id = NULL,
    updated_at = now()
  WHERE organization_id = target_org_id
    AND (
      reporting_engineer_id = ANY(user_ids)
      OR assigned_cashier_id = ANY(user_ids)
      OR cashier_assigned_engineer_id = ANY(user_ids)
    );

  UPDATE public.expenses
  SET assigned_engineer_id = NULL, assigned_reviewer_id = NULL, updated_at = now()
  WHERE organization_id = target_org_id
    AND (
      assigned_engineer_id = ANY(user_ids)
      OR assigned_reviewer_id = ANY(user_ids)
    );

  DELETE FROM public.engineer_locations WHERE engineer_id = ANY(user_ids);

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'team_members') THEN
    EXECUTE 'DELETE FROM public.team_members WHERE user_id = ANY($1)' USING user_ids;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'expense_submission_drafts') THEN
    EXECUTE 'DELETE FROM public.expense_submission_drafts WHERE user_id = ANY($1) AND organization_id = $2'
      USING user_ids, target_org_id;
  END IF;

  DELETE FROM public.notifications WHERE user_id = ANY(user_ids);

  UPDATE public.organization_memberships
  SET is_active = false
  WHERE organization_id = target_org_id AND user_id = ANY(user_ids);
  GET DIAGNOSTICS n_memberships = ROW_COUNT;

  UPDATE public.profiles
  SET is_active = false, deactivated_at = now(), updated_at = now()
  WHERE organization_id = target_org_id AND user_id = ANY(user_ids);
  GET DIAGNOSTICS n_profiles = ROW_COUNT;

  RAISE NOTICE 'Deactivated % membership(s), % profile(s). Expenses and audit history preserved.',
    n_memberships, n_profiles;
END $$;
`;

fs.writeFileSync(outPath, sql, "utf8");
console.log(`Wrote ${outPath} (${unique.length} employee IDs, excluded ${skipped} not in org)`);
