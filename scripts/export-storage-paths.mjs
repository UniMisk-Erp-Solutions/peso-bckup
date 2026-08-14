/**
 * Export storage.objects paths to JSON using DATABASE_URL (psql).
 * Includes expected byte size for verification during download.
 * Usage: BACKUP_DIR=... node scripts/export-storage-paths.mjs
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

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

const backupDir = process.env.BACKUP_DIR
  ? resolve(process.env.BACKUP_DIR)
  : resolve(projectRoot, "backups", `kqlqirdneocivumdjtvx_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`);
const outFile = join(backupDir, "storage_objects.json");
mkdirSync(backupDir, { recursive: true });

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL not set in .env");
  process.exit(1);
}

const sql = `
SELECT coalesce(
  json_agg(
    json_build_object(
      'bucket', b.name,
      'path', o.name,
      'size', nullif(o.metadata->>'size', '')::bigint
    )
    ORDER BY b.name, o.name
  ),
  '[]'::json
)::text
FROM storage.objects o
JOIN storage.buckets b ON b.id = o.bucket_id;
`;

const result = spawnSync("psql", [dbUrl, "-t", "-A", "-c", sql], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
  env: { ...process.env, PGSSLMODE: "require" },
});

if (result.status !== 0) {
  console.error(result.stderr?.toString() || "psql failed");
  process.exit(result.status ?? 1);
}

const jsonFile = join(backupDir, "storage_objects.json");
const rows = JSON.parse(result.stdout.trim() || "[]");
writeFileSync(jsonFile, JSON.stringify(rows, null, 0));
console.log(`Exported ${rows.length} storage objects → ${jsonFile}`);
