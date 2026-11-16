#!/usr/bin/env node
/**
 * Re-map and re-queue delivery for a completed/stuck sync job (force metadata refresh).
 * Usage: node scripts/tally-integration/rebuild-tally-delivery-job.mjs <job_id>
 */
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: node rebuild-tally-delivery-job.mjs <job_id>");
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pass = requireCoolifySshPassword();

await sshPsqlMutate(
  `
UPDATE tally_sync_jobs
SET parameters = COALESCE(parameters, '{}'::jsonb) || '{"tally_force_refresh": true}'::jsonb,
    status = 'prepared',
    completed_at = NULL,
    error_code = NULL,
    error_message_safe = NULL
WHERE id = '${jobId}';
DELETE FROM tally_sync_delivery_batches WHERE job_id = '${jobId}';
`,
  { password: pass },
);

console.log("Job reset to prepared + tally_force_refresh; batches cleared.");

const redispatch = join(ROOT, "scripts/tally-integration/redispatch-tally-delivery.mjs");
const r = spawnSync(process.execPath, [redispatch, jobId], { stdio: "inherit", cwd: ROOT });
process.exit(r.status ?? 1);
