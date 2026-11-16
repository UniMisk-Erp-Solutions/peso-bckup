#!/usr/bin/env node
/** Keep only the newest waiting job per report_type; supersede the rest. */
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();

await sshPsqlMutate(
  `
WITH keep AS (
  SELECT DISTINCT ON (report_type) id
  FROM tally_sync_jobs
  WHERE organization_id = '${ORG}'
    AND status IN ('waiting_for_connector', 'delivering')
  ORDER BY report_type, created_at DESC
)
UPDATE tally_sync_delivery_batches b
SET status = 'skipped', last_error_safe = 'superseded by newer sync'
FROM tally_sync_jobs j
WHERE j.id = b.job_id
  AND j.organization_id = '${ORG}'
  AND j.status IN ('waiting_for_connector', 'delivering')
  AND j.id NOT IN (SELECT id FROM keep);

UPDATE tally_sync_jobs j
SET status = 'failed',
    error_code = 'superseded',
    error_message_safe = 'Replaced by a newer sync for this report — use the latest Sync on Reports.'
WHERE j.organization_id = '${ORG}'
  AND j.status IN ('waiting_for_connector', 'delivering')
  AND j.id NOT IN (
    SELECT DISTINCT ON (report_type) id
    FROM tally_sync_jobs
    WHERE organization_id = '${ORG}'
      AND status IN ('waiting_for_connector', 'delivering')
    ORDER BY report_type, created_at DESC
  );
`,
  { password: pass },
);
console.log("Superseded old waiting jobs — one active queue per report type");
