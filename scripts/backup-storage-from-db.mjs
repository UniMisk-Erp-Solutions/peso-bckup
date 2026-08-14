/**
 * Fast parallel Storage backup from storage.objects paths (psql export).
 * Downloads every object — only skips files already verified complete on disk.
 *
 * Usage:
 *   BACKUP_DIR=... node scripts/export-storage-paths.mjs
 *   BACKUP_DIR=... node scripts/backup-storage-from-db.mjs
 *   FORCE=1 ...   re-download all
 *   CONCURRENCY=30 ... parallel workers (default 25)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const RETRIES = 4;
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "25", 10));
const FORCE = process.env.FORCE === "1" || process.env.FORCE === "true";

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

function formatError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return [err.message, err.error, err.statusCode && `HTTP ${err.statusCode}`].filter(Boolean).join(" | ");
}

function isCompleteOnDisk(dest, expectedSize) {
  if (!existsSync(dest)) return false;
  try {
    const localSize = statSync(dest).size;
    const expected = expectedSize != null ? Number(expectedSize) : null;
    if (expected === 0) return localSize === 0;
    if (localSize <= 0) return false;
    if (expected != null && expected > 0 && localSize !== expected) return false;
    return true;
  } catch {
    return false;
  }
}

loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const backupDir = process.env.BACKUP_DIR
  ? resolve(process.env.BACKUP_DIR)
  : resolve(projectRoot, "backups", `kqlqirdneocivumdjtvx_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`);
const jsonFile = join(backupDir, "storage_objects.json");
const storageRoot = join(backupDir, "storage_backup");

if (!url || !serviceKey) {
  console.error("Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
if (!existsSync(jsonFile)) {
  console.error(`Missing ${jsonFile} — run: node scripts/export-storage-paths.mjs`);
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const objects = JSON.parse(readFileSync(jsonFile, "utf8"));
const todo = FORCE ? objects : objects.filter((o) => !isCompleteOnDisk(join(storageRoot, o.bucket, o.path), o.size));
const alreadyComplete = objects.length - todo.length;

console.log(`Storage backup → ${storageRoot}`);
console.log(`Total: ${objects.length} | Already complete: ${alreadyComplete} | To download: ${todo.length} | Workers: ${CONCURRENCY}\n`);

let downloaded = 0;
let failed = 0;
let done = 0;
const errors = [];

async function downloadObject(bucket, objectPath, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const publicUrl = `${url}/storage/v1/object/public/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(200 * 2 ** attempt);
    try {
      const res = await fetch(publicUrl);
      if (res.ok) {
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        return;
      }
    } catch {
      /* fallback */
    }
    const { data, error } = await supabase.storage.from(bucket).download(objectPath);
    if (!error && data) {
      writeFileSync(dest, Buffer.from(await data.arrayBuffer()));
      return;
    }
    if (attempt === RETRIES - 1) throw error ?? new Error("download failed");
  }
}

async function worker(queue) {
  while (queue.length) {
    const item = queue.shift();
    if (!item) break;
    const { bucket, path: objectPath, size: expectedSize } = item;
    const dest = join(storageRoot, bucket, objectPath);
    try {
      await downloadObject(bucket, objectPath, dest);
      if (!isCompleteOnDisk(dest, expectedSize)) {
        const localSize = existsSync(dest) ? statSync(dest).size : -1;
        throw new Error(
          expectedSize != null
            ? `size mismatch (local ${localSize}, expected ${expectedSize})`
            : "empty file"
        );
      }
      downloaded++;
    } catch (err) {
      failed++;
      errors.push({ bucket, path: objectPath, expectedSize, message: formatError(err) });
    }
    done++;
    if (done % 50 === 0 || done === todo.length) {
      process.stdout.write(`  ${done}/${todo.length} downloaded (${downloaded} ok, ${failed} failed)\r`);
    }
  }
}

if (todo.length === 0) {
  console.log("All files already on disk — nothing to download.");
} else {
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker(queue)));
}

const totalOnDisk = objects.filter((o) => isCompleteOnDisk(join(storageRoot, o.bucket, o.path), o.size)).length;

console.log(`\nDone: ${downloaded} new downloads, ${alreadyComplete} already complete, ${failed} failed.`);
console.log(`Backup complete: ${totalOnDisk} / ${objects.length} files on disk.`);

const manifest = {
  exportedAt: new Date().toISOString(),
  supabaseUrl: url,
  totalObjects: objects.length,
  onDisk: totalOnDisk,
  downloaded,
  alreadyComplete,
  failed,
  complete: failed === 0 && totalOnDisk === objects.length,
};
writeFileSync(join(backupDir, "storage_manifest.json"), JSON.stringify(manifest, null, 2));
if (errors.length) {
  writeFileSync(join(backupDir, "storage_failed.json"), JSON.stringify(errors, null, 2));
  console.log(`Failed: ${join(backupDir, "storage_failed.json")}`);
}

process.exit(failed > 0 || totalOnDisk < objects.length ? 1 : 0);
