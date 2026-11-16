#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'job', (SELECT row_to_json(j) FROM (
    SELECT id, status, prepared_item_count, source_row_count, error_message_safe, created_at
    FROM tally_sync_jobs WHERE id='${jobId}'
  ) j),
  'batches', (SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb) FROM (
    SELECT status, count(*)::int c FROM tally_sync_delivery_batches WHERE job_id='${jobId}' GROUP BY status
  ) s),
  'sample_fail', (SELECT left(COALESCE(last_error_safe,tally_response_safe,''),300) FROM tally_sync_delivery_batches
    WHERE job_id='${jobId}' AND status IN ('failed','manual_review') LIMIT 1)
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
