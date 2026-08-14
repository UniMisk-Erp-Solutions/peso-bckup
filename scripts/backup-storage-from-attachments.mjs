/**
 * Download receipt files using paths from backup_api/public/attachments.json.
 * Avoids Storage list API (which rate-limits / returns HTML errors).
 * READ-ONLY — skips files already on disk.
 *
 * Usage: node scripts/backup-storage-from-attachments.mjs
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const DELAY_MS = 80;
const RETRIES = 4;

function extractReceiptStoragePath(fileUrl) {
  if (!fileUrl?.trim()) return null;
  const raw = fileUrl.trim();
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      for (const marker of ["/object/public/receipts/", "/object/public/expense-attachments/", "/object/sign/receipts/"]) {
        if (u.pathname.includes(marker)) {
          const key = u.pathname.split(marker)[1] || "";
          return decodeURIComponent(key.split("?")[0] || "") || null;
        }
      }
    }
  } catch {
    /* fall through */
  }
  if (raw.startsWith("receipts/")) return raw.slice("receipts/".length).split("?")[0] || null;
  if (raw.startsWith("expense-attachments/")) return raw.slice("expense-attachments/".length).split("?")[0] || null;
  if (!raw.includes("://") && !raw.startsWith("/")) return raw.split("?")[0] || null;
  return null;
}

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

loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const dateStamp = new Date().toISOString().slice(0, 10);
const backupDir = process.env.BACKUP_DIR
  ? resolve(process.env.BACKUP_DIR)
  : resolve(projectRoot, "..", `supabase_backup_${dateStamp}`);
const attachmentsFile = join(backupDir, "backup_api", "public", "attachments.json");
const storageRoot = join(backupDir, "storage_backup", "receipts");

if (!url) {
  console.error("Set VITE_SUPABASE_URL in .env");
  process.exit(1);
}
if (!existsSync(attachmentsFile)) {
  console.error(`Missing ${attachmentsFile} — run npm run backup:full:api first`);
  process.exit(1);
}

const attachments = JSON.parse(readFileSync(attachmentsFile, "utf8"));
const paths = new Set();
for (const row of attachments) {
  const fileUrl = row.file_url ?? row.fileUrl ?? row.url;
  if (!fileUrl || typeof fileUrl !== "string") continue;
  const key = extractReceiptStoragePath(fileUrl);
  if (key) paths.add(key);
}

console.log(`Attachment-based storage backup → ${storageRoot}`);
console.log(`Unique receipt paths from DB: ${paths.size}\n`);

let ok = 0;
let skipped = 0;
let failed = 0;
const errors = [];
const list = [...paths];

for (let i = 0; i < list.length; i++) {
  const objectPath = list[i];
  const dest = join(storageRoot, objectPath);
  if (existsSync(dest) && statSync(dest).size > 0) {
    skipped++;
    continue;
  }

  const publicUrl = `${url}/storage/v1/object/public/receipts/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
  mkdirSync(dirname(dest), { recursive: true });

  let saved = false;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) await sleep(DELAY_MS * 2 ** attempt);
    try {
      const res = await fetch(publicUrl);
      if (res.ok) {
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        ok++;
        saved = true;
        await sleep(DELAY_MS);
        break;
      }
      if (attempt === RETRIES - 1) errors.push({ path: objectPath, message: `HTTP ${res.status}` });
    } catch (err) {
      if (attempt === RETRIES - 1) errors.push({ path: objectPath, message: err?.message || String(err) });
    }
  }
  if (!saved && !existsSync(dest)) failed++;

  if ((i + 1) % 100 === 0 || i + 1 === list.length) {
    process.stdout.write(`  ${i + 1}/${list.length} (saved ${ok}, skipped ${skipped}, failed ${failed})\r`);
  }
}

console.log(`\nDone: ${ok} saved, ${skipped} skipped, ${failed} failed.`);
console.log(
  skipped > 0
    ? "  skipped = already on your PC from a previous run (good, not an error)"
    : "",
);
console.log(
  failed > 0
    ? "  failed = file is in the database but missing from Supabase Storage (HTTP 400/404). Cannot re-download."
    : "",
);
if (errors.length) {
  writeFileSync(join(backupDir, "storage_failed_attachments.json"), JSON.stringify(errors, null, 2));
  console.log(`Failed paths: ${join(backupDir, "storage_failed_attachments.json")}`);
}
