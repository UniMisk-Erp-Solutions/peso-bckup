#!/usr/bin/env node
/** Cancel ancient waiting_for_connector jobs that block the delivery queue (FIFO by job_id bug). */
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
// Keep jobs from last 24h; cancel older waiting jobs and skip their batches.
await sshPsqlMutate(
  `
UPDATE tally_sync_delivery_batches b
SET status = 'skipped', last_error_safe = 'superseded — stale queue cleanup'
FROM tally_sync_jobs j
WHERE j.id = b.job_id
  AND j.organization_id = '${ORG}'
  AND j.status = 'waiting_for_connector'
  AND j.created_at < now() - interval '24 hours';

UPDATE tally_sync_jobs
SET status = 'failed',
    error_code = 'superseded',
    error_message_safe = 'Cancelled — older sync replaced by newer runs. Use Sync again if needed.'
WHERE organization_id = '${ORG}'
  AND status = 'waiting_for_connector'
  AND created_at < now() - interval '24 hours';
`,
  { password: pass },
);
console.log("Cancelled stale waiting jobs (>24h)");
