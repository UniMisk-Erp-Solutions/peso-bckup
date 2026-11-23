#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
if (!jobId) process.exit(2);
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'failed', (SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT id, batch_index, status, message_count, attempt_count, max_attempts,
           last_error_safe, left(COALESCE(tally_response_safe,''), 800) AS tally_response_safe,
           updated_at
    FROM tally_sync_delivery_batches WHERE job_id = '${jobId}' AND status = 'failed'
    ORDER BY batch_index LIMIT 10
  ) t),
  'first_pending', (SELECT row_to_json(t) FROM (
    SELECT id, batch_index, status, message_count FROM tally_sync_delivery_batches
    WHERE job_id = '${jobId}' AND status = 'pending' ORDER BY batch_index LIMIT 1
  ) t),
  'job_org', (SELECT organization_id::text FROM tally_sync_jobs WHERE id = '${jobId}'),
  'xml_head', (SELECT left(COALESCE(xml_payload,''), 900) FROM tally_sync_delivery_batches
    WHERE job_id = '${jobId}' AND status = 'failed' ORDER BY batch_index LIMIT 1)
);
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
