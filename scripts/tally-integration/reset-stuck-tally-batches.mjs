#!/usr/bin/env node
/** Reset claimed/failed delivery batches for a job so the bridge can retry (Coolify SSH). */
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: node reset-stuck-tally-batches.mjs <job_id> [--rematerialize]");
  process.exit(2);
}

const pass = requireCoolifySshPassword();
const rematerialize = process.argv.includes("--rematerialize");
const sql = rematerialize
  ? `
WITH deleted AS (
  DELETE FROM tally_sync_delivery_batches WHERE job_id = '${jobId}' RETURNING id
),
job_up AS (
  UPDATE tally_sync_jobs
  SET status = 'queued',
      error_code = NULL,
      error_message_safe = NULL,
      completed_at = NULL,
      parameters = COALESCE(parameters, '{}'::jsonb)
        - '_tally_delivery_after_seq'
        - '_tally_delivery_registry'
  WHERE id = '${jobId}'
  RETURNING id
)
SELECT jsonb_build_object(
  'batches_deleted', (SELECT count(*)::int FROM deleted),
  'job_prepared_for_remap', (SELECT count(*)::int FROM job_up),
  'batches_by_status', (
    SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
    FROM (SELECT status, count(*)::int AS c FROM tally_sync_delivery_batches WHERE job_id = '${jobId}' GROUP BY status) s
  ),
  'job_status', (SELECT status FROM tally_sync_jobs WHERE id = '${jobId}')
);
`
  : `
WITH reset AS (
  UPDATE tally_sync_delivery_batches
  SET status = 'pending',
      claimed_by = NULL,
      claimed_at = NULL,
      lease_expires_at = NULL,
      last_error_safe = NULL
  WHERE job_id = '${jobId}'
    AND status IN ('claimed', 'failed')
  RETURNING id
),
job_up AS (
  UPDATE tally_sync_jobs
  SET status = 'waiting_for_connector',
      error_code = NULL,
      error_message_safe = NULL,
      completed_at = NULL
  WHERE id = '${jobId}'
    AND status IN ('failed', 'delivering', 'tally_delivery_failed')
  RETURNING id
)
SELECT jsonb_build_object(
  'batches_reset', (SELECT count(*)::int FROM reset),
  'job_reopened', (SELECT count(*)::int FROM job_up),
  'batches_by_status', (
    SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
    FROM (SELECT status, count(*)::int AS c FROM tally_sync_delivery_batches WHERE job_id = '${jobId}' GROUP BY status) s
  ),
  'job_status', (SELECT status FROM tally_sync_jobs WHERE id = '${jobId}')
);
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
