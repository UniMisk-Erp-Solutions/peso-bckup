#!/usr/bin/env node
/**
 * Recovery validation orchestrator (local/lab). Does not connect to production by default.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

const checks = [
  ["path guard (prod block)", "bash", [path.join(root, "scripts/recovery/recovery-path-guard.sh"), "/var/lib/postgresql/data/kar0ro1k6jiyfxzzw7acnsza"], 1],
  ["restore dry-run", "bash", [path.join(root, "scripts/recovery/restore-pitr.sh"), "--base-backup", "/tmp/lab/base", "--wal-dir", "/tmp/lab/wal", "--target-time", "2026-01-01T00:00:00+00", "--target-dir", "/tmp/pesowise-recovery-test"], 0],
];

console.log("RECOVERY VALIDATION\n");
let fail = 0;
for (const [name, cmd, args, expectCode] of checks) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  const ok = (r.status ?? 1) === expectCode;
  console.log(`${name}: ${ok ? "PASS" : "FAIL"}`);
  if (!ok) fail = 1;
}
console.log(fail ? "\nFINAL: FAIL" : "\nFINAL: PASS (tooling only; production PITR see PITR_PRODUCTION_READINESS.md)");
process.exit(fail);
