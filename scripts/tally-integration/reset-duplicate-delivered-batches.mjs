#!/usr/bin/env node
/** Re-queue delivered batches that have 0 created/0 altered (pre-Phase-3 false positives). */
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: node reset-duplicate-delivered-batches.mjs <job_id>");
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
    last_error_safe = NULL,
    tally_response_safe = NULL,
    ack_summary = NULL,
    attempt_count = 0
WHERE job_id = '${jobId}'
  AND status = 'delivered'
  AND coalesce((ack_summary->>'created')::int, 0) = 0
  AND coalesce((ack_summary->>'altered')::int, 0) = 0;
UPDATE tally_sync_jobs
SET status = 'waiting_for_connector',
    completed_at = NULL,
    error_message_safe = NULL
WHERE id = '${jobId}';
`,
  { password: pass },
);
console.log("Reset duplicate-only delivered batches to pending for", jobId);
