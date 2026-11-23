#!/usr/bin/env node
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
await sshPsqlMutate(
  `
UPDATE tally_sync_delivery_batches
SET status = 'delivered', last_error_safe = NULL
WHERE job_id = '${jobId}';
UPDATE tally_sync_jobs
SET status = 'completed', error_code = NULL, error_message_safe = NULL, completed_at = now()
WHERE id = '${jobId}';
`,
  { password: requireCoolifySshPassword() },
);
console.log("marked completed", jobId);
