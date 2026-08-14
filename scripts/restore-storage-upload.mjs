/**
 * Upload local storage_backup/receipts files to Supabase Storage (new project).
 * READ-ONLY on local files; writes to remote bucket only.
 *
 * Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (must be NEW project keys)
 *      BACKUP_DIR optional
 *
 * Usage: node scripts/restore-storage-upload.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const BUCKET = "receipts";
const DELAY_MS = 50;

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base));
    else out.push(relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}

function guessContentType(path) {
  const p = path.toLowerCase();
  if (p.endsWith(".pdf")) return "application/pdf";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dateStamp = "2026-05-30";
const backupDir = process.env.BACKUP_DIR
  ? resolve(process.env.BACKUP_DIR)
  : resolve(projectRoot, "..", `supabase_backup_${dateStamp}`);
const receiptsDir = join(backupDir, "storage_backup", "receipts");

if (!url || !serviceKey) {
  console.error("Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (NEW project) in .env");
  process.exit(1);
}
if (!existsSync(receiptsDir)) {
  console.error(`Missing ${receiptsDir}`);
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const files = walkFiles(receiptsDir);
console.log(`Uploading ${files.length} files to ${url} bucket "${BUCKET}"...\n`);

let ok = 0;
let failed = 0;

for (let i = 0; i < files.length; i++) {
  const objectPath = files[i];
  const localPath = join(receiptsDir, objectPath);
  const body = readFileSync(localPath);
  const { error } = await supabase.storage.from(BUCKET).upload(objectPath, body, {
    contentType: guessContentType(objectPath),
    upsert: true,
  });
  if (error) {
    failed++;
    if (failed <= 5) console.error("FAIL", objectPath, error.message);
  } else {
    ok++;
  }
  if ((i + 1) % 100 === 0 || i + 1 === files.length) {
    process.stdout.write(`  ${i + 1}/${files.length} (ok ${ok}, failed ${failed})\r`);
  }
  await sleep(DELAY_MS);
}

console.log(`\nDone: ${ok} uploaded, ${failed} failed.`);
