#!/usr/bin/env node
/** Reset failed/stuck delivery for active MicroLink tally jobs (keeps prepared data). */
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
await sshPsqlMutate(
  `
UPDATE tally_sync_delivery_batches b
SET status = 'pending',
    attempt_count = 0,
    claimed_by = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL,
    last_error_safe = NULL,
    ack_summary = NULL
FROM tally_sync_jobs j
WHERE j.id = b.job_id
  AND j.organization_id = '${ORG}'
  AND j.status IN ('failed', 'waiting_for_connector', 'delivering')
  AND b.status IN ('failed', 'claimed');

UPDATE tally_sync_jobs
SET status = 'waiting_for_connector',
    error_code = NULL,
    error_message_safe = NULL,
    completed_at = NULL
WHERE organization_id = '${ORG}'
  AND status IN ('failed', 'delivering')
  AND report_type IN ('daily_project_report', 'claim_verification', 'claim_approval', 'detailed_expense');
`,
  { password: pass },
);
console.log("Requeued active/failed batches for MicroLink org");
