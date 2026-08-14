/**
 * Database backup via Supabase API + service role (READ-ONLY).
 * Use when pg_dump fails (wrong DB password or IPv6-only direct host).
 *
 * Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional BACKUP_DIR
 *
 * Output: backup_api/public/*.json, backup_api/auth_users.json
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const PAGE = 1000;

const PUBLIC_TABLES = [
  "organizations",
  "organization_memberships",
  "organization_settings",
  "organization_features",
  "organization_transaction_sequences",
  "organization_payments",
  "organization_expense_form_fields",
  "organization_bank_accounts",
  "profiles",
  "user_roles",
  "master_admin_memberships",
  "locations",
  "engineer_locations",
  "teams",
  "team_members",
  "expenses",
  "expense_batches",
  "expense_line_items",
  "expense_categories",
  "expense_form_field_templates",
  "expense_category_form_fields",
  "expense_form_field_values",
  "expense_form_field_option_branches",
  "expense_correction_logs",
  "attachments",
  "audit_logs",
  "notifications",
  "money_assignments",
  "money_return_requests",
  "cash_transfer_history",
  "settings",
  "subscription_plans",
  "master_admin_announcements",
  "bank_accounts",
  "system_config",
  "booking_requested_vehicles",
  "bills",
  "contact_leads",
  "strategies",
  "category_usage_tracking",
  "form_field_option_usage_tracking",
  "employee_auth_lookup_attempts",
];

function loadEnv() {
  for (const name of [".env.local", ".env"]) {
    const p = resolve(projectRoot, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  }
}

loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dateStamp = new Date().toISOString().slice(0, 10);
const backupDir = process.env.BACKUP_DIR
  ? resolve(process.env.BACKUP_DIR)
  : resolve(projectRoot, "..", `supabase_backup_${dateStamp}`);
const outDir = join(backupDir, "backup_api", "public");

if (!url || !serviceKey) {
  console.error("Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function fetchAllRows(table) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select("*").range(from, from + PAGE - 1);
    if (error) {
      if (error.code === "42P01" || error.message?.includes("does not exist")) return { rows, skipped: true };
      throw new Error(`${table}: ${error.message}`);
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return { rows, skipped: false };
}

async function fetchAuthUsers() {
  const users = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const batch = data?.users ?? [];
    users.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return users;
}

mkdirSync(outDir, { recursive: true });

const manifest = { exportedAt: new Date().toISOString(), tables: {}, authUsers: 0 };

console.log(`API database backup (read-only) → ${join(backupDir, "backup_api")}\n`);

for (const table of PUBLIC_TABLES) {
  process.stdout.write(`  ${table} ... `);
  try {
    const { rows, skipped } = await fetchAllRows(table);
    if (skipped) {
      console.log("skip (not in API)");
      manifest.tables[table] = { rows: 0, skipped: true };
      continue;
    }
    writeFileSync(join(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
    manifest.tables[table] = { rows: rows.length };
    console.log(`${rows.length} rows`);
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    manifest.tables[table] = { error: err.message };
  }
}

console.log("\n  auth.users (admin API) ...");
try {
  const users = await fetchAuthUsers();
  writeFileSync(join(backupDir, "backup_api", "auth_users.json"), JSON.stringify(users, null, 2));
  manifest.authUsers = users.length;
  console.log(`  ${users.length} users`);
} catch (err) {
  manifest.authUsersError = err.message;
  console.log(`  ERROR: ${err.message}`);
}

writeFileSync(join(backupDir, "backup_api", "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nDone. See ${join(backupDir, "backup_api", "manifest.json")}`);
