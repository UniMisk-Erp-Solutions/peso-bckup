#!/usr/bin/env node
/**
 * One-shot: sync TDL → rebuild latest daily sync delivery → local deliver → DPR UDF backfill.
 * Requires: TallyPrime open on PesoWise Integration Test, port 9000, npm run dev (bridge 9876).
 */
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const run = (rel, args = []) => {
  const r = spawnSync(process.execPath, [join(ROOT, rel), ...args], { cwd: ROOT, stdio: "inherit" });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
};

run("scripts/tally-integration/sync-tdl-to-pesowise-folder.mjs");

const pass = requireCoolifySshPassword();
const jobRow = await sshPsqlJson(
  `SELECT id::text AS id FROM tally_sync_jobs WHERE organization_id='${ORG}' AND report_type='daily_project_report' ORDER BY created_at DESC LIMIT 1;`,
  { password: pass },
);
const jobId = Array.isArray(jobRow) ? jobRow[0]?.id : jobRow?.id;
if (!jobId) {
  console.error("No daily_project_report sync job found — run Sync to Tally in the app first.");
  process.exit(2);
}
console.log("Using job", jobId);

run("scripts/tally-integration/rebuild-tally-delivery-job.mjs", [jobId]);

const deliver = await fetch("http://127.0.0.1:9876/v1/deliver-job", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ job_id: jobId }),
}).catch(() => null);
if (!deliver?.ok && deliver?.status !== 202) {
  console.warn("Local bridge not delivering — keep app open (npm run dev) and click Sync, or re-run deliver.");
} else {
  console.log("Delivery started on local bridge… waiting 90s");
  await new Promise((r) => setTimeout(r, 90_000));
}

run("scripts/tally-integration/fix-daily-tally-report-empty.mjs");
console.log("\nDone. In Tally: Gateway → PesoWise Reports → Daily Project (real report, not safe shell).");
