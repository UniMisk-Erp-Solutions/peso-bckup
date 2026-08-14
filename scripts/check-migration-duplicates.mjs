#!/usr/bin/env node
/**
 * check-migration-duplicates.mjs
 *
 * Scans supabase/migrations/ for:
 *   1. Duplicate 14-digit version prefixes.
 *      - KNOWN HISTORICAL DUPLICATE — tolerated (listed in migration-version-baseline.json)
 *      - NEW DUPLICATE — release blocker (any duplicate not in the baseline, or a baseline
 *        entry whose filenames no longer match exactly)
 *   2. Non-standard filenames (not starting with a 14-digit version) — WARN, not blocking.
 *
 * Exit code 0 = clean (only approved baseline duplicates found, if any).
 * Exit code 1 = NEW duplicate detected, or a baseline entry is stale / missing files.
 *
 * Does NOT rename, delete, or modify any migration file.
 */

import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS_DIR = resolve(ROOT, "supabase/migrations");
const BASELINE_PATH = resolve(ROOT, "scripts/migration-version-baseline.json");

// ---------------------------------------------------------------------------
// Load baseline
// ---------------------------------------------------------------------------
let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch (err) {
  console.error(`\n❌  Cannot read baseline file at ${BASELINE_PATH}: ${err.message}\n`);
  process.exit(1);
}

/** Map: version → Set<filename> (approved) */
const approvedMap = new Map();
for (const entry of baseline.approvedDuplicates ?? []) {
  approvedMap.set(entry.version, new Set(entry.files));
}

// ---------------------------------------------------------------------------
// Scan migrations directory
// ---------------------------------------------------------------------------
const VERSION_RE = /^(\d{14})_/;
const allFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

const versionMap = new Map(); // version → [filename, ...]
const nonStandard = [];

for (const file of allFiles) {
  const m = file.match(VERSION_RE);
  if (!m) {
    nonStandard.push(file);
    continue;
  }
  const version = m[1];
  if (!versionMap.has(version)) versionMap.set(version, []);
  versionMap.get(version).push(file);
}

// ---------------------------------------------------------------------------
// Classify duplicates
// ---------------------------------------------------------------------------
const duplicates = [...versionMap.entries()].filter(([, files]) => files.length > 1);

const known = [];
const blocking = [];

for (const [version, files] of duplicates) {
  const approvedSet = approvedMap.get(version);
  const actualSet = new Set(files);

  if (
    approvedSet &&
    approvedSet.size === actualSet.size &&
    [...actualSet].every((f) => approvedSet.has(f))
  ) {
    known.push({ version, files });
  } else {
    blocking.push({ version, files, approvedSet });
  }
}

// ---------------------------------------------------------------------------
// Also check: do any baseline entries reference files that no longer exist?
// ---------------------------------------------------------------------------
const missingBaselineFiles = [];
for (const [version, approvedSet] of approvedMap.entries()) {
  for (const expectedFile of approvedSet) {
    if (!allFiles.includes(expectedFile)) {
      missingBaselineFiles.push({ version, file: expectedFile });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let exitCode = 0;

if (known.length > 0) {
  console.log("\n⚠️   KNOWN HISTORICAL DUPLICATES — tolerated (listed in migration-version-baseline.json):\n");
  for (const { version, files } of known) {
    console.log(`  Version ${version}:`);
    for (const f of files) console.log(`    - ${f}`);
  }
}

if (blocking.length > 0) {
  console.error("\n❌  NEW DUPLICATE — release blocker\n");
  for (const { version, files, approvedSet } of blocking) {
    console.error(`  Version ${version}:`);
    for (const f of files) console.error(`    - ${f}`);
    if (approvedSet) {
      console.error(`  (Baseline expected: ${[...approvedSet].join(", ")})`);
    }
  }
  console.error(
    "\n  New duplicates will cause `supabase db push` to apply only one file and silently skip" +
    " the other.\n  Add to migration-version-baseline.json ONLY if these are approved historical" +
    " files that cannot be renamed.\n  Otherwise rename the newer file with a unique timestamp.\n"
  );
  exitCode = 1;
}

if (missingBaselineFiles.length > 0) {
  console.error("\n❌  BASELINE STALE — files listed in baseline no longer exist:\n");
  for (const { version, file } of missingBaselineFiles) {
    console.error(`  Version ${version}: ${file}`);
  }
  console.error(
    "\n  Update migration-version-baseline.json to reflect the current migration filenames.\n"
  );
  exitCode = 1;
}

if (blocking.length === 0 && missingBaselineFiles.length === 0) {
  if (known.length === 0) {
    console.log("✅  No duplicate migration versions found.");
  } else {
    console.log(
      `\n✅  All ${known.length} duplicate version(s) are approved historical duplicates — OK to proceed.`
    );
  }
}

if (nonStandard.length > 0) {
  console.warn("\n⚠️   NON-STANDARD MIGRATION FILENAMES (informational — not blocking):\n");
  for (const f of nonStandard) console.warn(`  - ${f}`);
  console.warn(
    "\n  These files do not start with a 14-digit timestamp and will be" +
    " ignored by the Supabase CLI migration runner.\n"
  );
}

console.log(`\nScanned ${allFiles.length} .sql files in ${MIGRATIONS_DIR}`);
process.exit(exitCode);
