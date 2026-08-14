/**
 * Download all objects from Supabase Storage buckets to local disk (READ-ONLY).
 * Skips files already on disk. Retries with backoff on rate limits.
 *
 * Usage: node scripts/backup-storage-files.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const RETRIES = 4;
const DELAY_MS = 120;

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
  const parts = [err.message, err.error, err.statusCode && `HTTP ${err.statusCode}`].filter(Boolean);
  if (parts.length) return parts.join(" | ");
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const buckets = (process.env.STORAGE_BUCKETS || "receipts")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);

const dateStamp = new Date().toISOString().slice(0, 10);
const defaultBackupDir = resolve(projectRoot, "..", `supabase_backup_${dateStamp}`);
const backupDir = process.env.BACKUP_DIR ? resolve(process.env.BACKUP_DIR) : defaultBackupDir;
const storageRoot = join(backupDir, "storage_backup");

if (!url || !serviceKey) {
  console.error("Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function listAllFiles(bucket, prefix = "") {
  const files = [];
  const limit = 100;
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit, offset });
    if (error) {
      if (error.message?.includes("not found")) return files;
      throw error;
    }
    if (!data?.length) break;

    for (const item of data) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id == null) {
        files.push(...(await listAllFiles(bucket, path)));
      } else {
        files.push(path);
      }
    }

    if (data.length < limit) break;
    offset += limit;
  }

  return files;
}

async function downloadFile(bucket, objectPath, destPath) {
  if (existsSync(destPath)) {
    try {
      if (statSync(destPath).size > 0) return "skipped";
    } catch {
      // re-download
    }
  }

  mkdirSync(dirname(destPath), { recursive: true });

  // Prefer public URL (receipts bucket is public) — avoids Storage API rate limits.
  const publicUrl = `${url}/storage/v1/object/public/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;

  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(DELAY_MS * 2 ** attempt);
    try {
      const res = await fetch(publicUrl);
      if (res.ok) {
        writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
        await sleep(DELAY_MS);
        return "ok";
      }
      lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (err) {
      lastErr = err;
    }
  }

  // Fallback: Storage API download
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(DELAY_MS * 2 ** attempt);
    const { data, error } = await supabase.storage.from(bucket).download(objectPath);
    if (!error && data) {
      writeFileSync(destPath, Buffer.from(await data.arrayBuffer()));
      await sleep(DELAY_MS);
      return "ok";
    }
    lastErr = error;
  }

  throw lastErr ?? new Error("download failed");
}

const manifest = { exportedAt: new Date().toISOString(), supabaseUrl: url, buckets: {} };

console.log(`Storage backup (read-only) → ${storageRoot}\n`);

for (const bucket of buckets) {
  console.log(`Listing bucket "${bucket}"...`);
  const paths = await listAllFiles(bucket);
  console.log(`  Found ${paths.length} file(s).`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < paths.length; i++) {
    const objectPath = paths[i];
    const dest = join(storageRoot, bucket, objectPath);
    try {
      const result = await downloadFile(bucket, objectPath, dest);
      if (result === "skipped") skipped++;
      else ok++;
      if ((i + 1) % 50 === 0 || i + 1 === paths.length) {
        process.stdout.write(`  Progress ${i + 1}/${paths.length} (saved ${ok}, skipped ${skipped}, failed ${failed})\r`);
      }
    } catch (err) {
      failed++;
      errors.push({ path: objectPath, message: formatError(err) });
    }
  }

  console.log(`\n  Bucket "${bucket}": ${ok} saved, ${skipped} skipped, ${failed} failed.`);
  manifest.buckets[bucket] = { total: paths.length, downloaded: ok, skipped, failed, errors: errors.slice(0, 50) };
  if (errors.length) {
    writeFileSync(join(backupDir, `storage_failed_${bucket}.json`), JSON.stringify(errors, null, 2));
  }
}

mkdirSync(backupDir, { recursive: true });
writeFileSync(join(backupDir, "storage_manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nDone. Files under ${storageRoot}`);
