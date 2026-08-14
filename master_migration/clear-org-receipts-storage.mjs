/**
 * Delete receipt objects for one organization via Supabase Storage API.
 * Supabase blocks DELETE FROM storage.objects in SQL (storage.protect_delete).
 *
 * Prerequisite: env
 *   VITE_SUPABASE_URL or SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (Dashboard → Project Settings → API; never commit)
 *
 * Usage:
 *   node master_migration/clear-org-receipts-storage.mjs <organization_uuid>
 *
 * Run this BEFORE master_migration/clear_org_expense_data_and_create_trial.sql
 * so expense IDs still exist for folder cleanup. (Temp paths use membership user_ids.)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ORG_ID = process.argv[2]?.trim();
if (!ORG_ID) {
  console.error("Usage: node clear-org-receipts-storage.mjs <organization_uuid>");
  process.exit(1);
}

function loadEnv() {
  const root = resolve(process.cwd());
  for (const name of [".env.local", ".env"]) {
    const p = resolve(root, name);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = "receipts";

async function emptyStorageFolder(folderPath) {
  const limit = 100;
  let totalRemoved = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(BUCKET).list(folderPath, {
      limit,
      offset: 0,
    });
    if (error) {
      if (error.message?.includes("not found") || error.message?.includes("The resource was not found")) {
        return totalRemoved;
      }
      throw error;
    }
    if (!data?.length) break;

    const paths = data.map((f) => (folderPath ? `${folderPath}/${f.name}` : f.name));
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
    if (rmErr) throw rmErr;
    totalRemoved += paths.length;
    if (data.length < limit) break;
  }
  return totalRemoved;
}

const { data: expenses, error: expErr } = await supabase
  .from("expenses")
  .select("id")
  .eq("organization_id", ORG_ID);

if (expErr) throw expErr;

let removed = 0;
for (const row of expenses || []) {
  const id = row.id;
  removed += await emptyStorageFolder(String(id));
}

const { data: members, error: memErr } = await supabase
  .from("organization_memberships")
  .select("user_id")
  .eq("organization_id", ORG_ID);

if (memErr) throw memErr;

for (const row of members || []) {
  removed += await emptyStorageFolder(`temp/${row.user_id}`);
}

console.log(
  `Storage cleanup done for org ${ORG_ID}: removed ${removed} object(s) from bucket "${BUCKET}" (${(expenses || []).length} expense folder(s), ${(members || []).length} temp user folder(s)).`
);
