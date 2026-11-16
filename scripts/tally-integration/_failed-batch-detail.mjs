#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(t) ORDER BY batch_index) FROM (
  SELECT batch_index, status, message_count, left(last_error_safe,300) err,
    left(tally_response_safe,400) resp,
    (xml_payload LIKE '%PESOWISE_METADATA_JSON.LIST%') AS old_list_shape,
    length(xml_payload) xml_len
  FROM tally_sync_delivery_batches
  WHERE job_id='${jobId}' AND status IN ('failed','delivered')
  ORDER BY batch_index
) t;`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
