/**
 * Builds 3 manual SQL section files from supabase/migrations.
 * Run: node scripts/post-restore/build-manual-sections.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const migrationsDir = join(root, "supabase/migrations");
const outDir = __dirname;

const hierarchyMigrations = [
  "20260524180000_expense_hierarchy_review_select_expand.sql",
  "20260524190000_list_organizations_for_dev_login.sql",
  "20260524190100_fix_dev_tenant_list_use_slug.sql",
  "20260524200000_tl_executive_expense_submit_and_select.sql",
  "20260524210000_list_hierarchy_reviewer_expenses_rpc.sql",
  "20260524220000_fix_hierarchy_reviewer_act_permissions.sql",
  "20260524230000_fix_hierarchy_verify_advance.sql",
  "20260524240000_hierarchy_tl_verify_fix.sql",
  "20260524250000_hierarchy_verification_statuses.sql",
  "20260524250100_hierarchy_verification_statuses_apply.sql",
  "20260524260000_fix_hierarchy_verify_status_by_role.sql",
  "20260524270000_backfill_level2_queue_after_tl_verify.sql",
  "20260524280000_manager_review_queue_and_managing_engineer.sql",
  "20260524290000_expand_manager_team_visibility.sql",
  "20260524300000_fix_level2_verified_manager_queue.sql",
  "20260524310000_executive_handoff_to_manager_level2.sql",
  "20260524320000_manager_sees_stuck_executive_queue.sql",
  "20260524330000_manager_verify_auto_repair.sql",
];

const managerMigration = "20260528183500_manager_visibility_stable_rpc.sql";

function readMigration(name) {
  return readFileSync(join(migrationsDir, name), "utf8").trim();
}

function banner(title, subtitle) {
  return [
    "-- =============================================================================",
    `-- ${title}`,
    subtitle ? `-- ${subtitle}` : "",
    "-- =============================================================================",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

const section1 = `${banner(
  "SECTION 1 of 3 — Run FIRST (Supabase SQL Editor)",
  "Grants + rewrite URLs to kqlqirdneocivumdjtvx. ~1 minute.",
)}
-- Old project in backup URLs: briypgrgqagbexudarba
-- Live project:            kqlqirdneocivumdjtvx

-- 300526_1200_fix_public_schema_grants_after_restore.sql
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA storage TO postgres, anon, authenticated, service_role;

-- 270526_0530_rewrite_attachment_urls_to_new_project.sql
UPDATE public.attachments
SET file_url = replace(file_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE file_url LIKE '%briypgrgqagbexudarba%';

UPDATE public.organizations
SET logo_url = replace(logo_url, 'briypgrgqagbexudarba', 'kqlqirdneocivumdjtvx')
WHERE logo_url IS NOT NULL
  AND logo_url LIKE '%briypgrgqagbexudarba%';

-- Quick check (optional)
SELECT COUNT(*) AS attachments_still_on_old_project
FROM public.attachments
WHERE file_url LIKE '%briypgrgqagbexudarba%';
`;

let section2 = banner(
  "SECTION 2 of 3 — Run SECOND",
  "18 hierarchy / review migrations (May 27 evening batch). May take 30–90 seconds.",
);
for (let i = 0; i < hierarchyMigrations.length; i++) {
  const name = hierarchyMigrations[i];
  section2 += `\n-- ---------------------------------------------------------------------------\n`;
  section2 += `-- ${i + 1} / ${hierarchyMigrations.length}: ${name}\n`;
  section2 += `-- ---------------------------------------------------------------------------\n\n`;
  section2 += readMigration(name);
  section2 += "\n\n";
}

let section3 = banner(
  "SECTION 3 of 3 — Run THIRD",
  "Manager visibility RPC + final checks.",
);
section3 += "\n";
section3 += readMigration(managerMigration);
section3 += `

-- =============================================================================
-- VERIFICATION (read results)
-- =============================================================================

SELECT 'expenses' AS tbl, COUNT(*)::bigint AS cnt FROM public.expenses
UNION ALL SELECT 'attachments', COUNT(*) FROM public.attachments
UNION ALL SELECT 'profiles', COUNT(*) FROM public.profiles
UNION ALL SELECT 'organizations', COUNT(*) FROM public.organizations;

SELECT COUNT(*) AS attachments_still_on_old_project
FROM public.attachments
WHERE file_url LIKE '%briypgrgqagbexudarba%';

SELECT COUNT(*) AS receipt_files_in_storage
FROM storage.objects
WHERE bucket_id = 'receipts';

-- Next (not SQL): npm run post-restore:storage
`;

writeFileSync(join(outDir, "manual-section-1-grants-and-urls.sql"), section1, "utf8");
writeFileSync(join(outDir, "manual-section-2-hierarchy-migrations.sql"), section2, "utf8");
writeFileSync(join(outDir, "manual-section-3-manager-and-verify.sql"), section3, "utf8");

console.log("Wrote:");
console.log("  manual-section-1-grants-and-urls.sql");
console.log("  manual-section-2-hierarchy-migrations.sql");
console.log("  manual-section-3-manager-and-verify.sql");
