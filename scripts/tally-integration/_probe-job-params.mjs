#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'status', status,
  'prepared_item_count', prepared_item_count,
  'parameters', parameters,
  'batch_rows', (
    SELECT jsonb_agg(row_to_json(t) ORDER BY batch_index)
    FROM (
      SELECT batch_index, status, message_count, length(xml_payload) AS xml_len
      FROM tally_sync_delivery_batches WHERE job_id = '${jobId}'
    ) t
  )
) FROM tally_sync_jobs WHERE id = '${jobId}';
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
