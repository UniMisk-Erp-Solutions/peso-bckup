#!/usr/bin/env node
/** Re-queue failed/pending jobs after duplicate-only max_attempts false failure. */
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: node reset-failed-duplicate-batches.mjs <job_id>");
  process.exit(2);
}
const pass = requireCoolifySshPassword();
await sshPsqlMutate(
  `
UPDATE tally_sync_delivery_batches
SET status = 'pending',
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    attempt_count = 0,
    last_error_safe = NULL
WHERE job_id = '${jobId}'
  AND status IN ('failed', 'claimed')
  AND (last_error_safe ILIKE '%duplicate%' OR last_error_safe ILIKE '%udf%');
UPDATE tally_sync_jobs
SET status = 'waiting_for_connector',
    error_code = NULL,
    error_message_safe = NULL,
    completed_at = NULL
WHERE id = '${jobId}';
`,
  { password: pass },
);
console.log("Reset duplicate-failed batches for", jobId);
