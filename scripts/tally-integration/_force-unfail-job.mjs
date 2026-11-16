#!/usr/bin/env node
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
await sshPsqlMutate(
  `
UPDATE tally_sync_delivery_batches
SET status='pending', attempt_count=0, claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL,
    last_error_safe=NULL, ack_summary=NULL
WHERE job_id='${jobId}';
UPDATE tally_sync_jobs
SET status='waiting_for_connector', error_code=NULL, error_message_safe=NULL, completed_at=NULL
WHERE id='${jobId}';
`,
  { password: pass },
);
console.log("Unfailed job", jobId);
