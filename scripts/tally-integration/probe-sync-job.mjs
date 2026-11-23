#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: node probe-sync-job.mjs <job_id>");
  process.exit(2);
}
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'job', (SELECT row_to_json(t) FROM (
    SELECT id, status, report_type, prepared_item_count, source_row_count,
           error_code, error_message_safe, created_at, completed_at
    FROM tally_sync_jobs WHERE id = '${jobId}'
  ) t),
  'items', (SELECT count(*)::int FROM tally_sync_job_items WHERE job_id = '${jobId}'),
  'batch_total', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id = '${jobId}'),
  'batches_by_status', (
    SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
    FROM (SELECT status, count(*)::int AS c FROM tally_sync_delivery_batches WHERE job_id = '${jobId}' GROUP BY status) s
  )
);
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
