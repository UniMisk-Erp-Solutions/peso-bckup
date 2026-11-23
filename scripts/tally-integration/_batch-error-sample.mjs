#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(t)) FROM (
  SELECT batch_index, status, left(last_error_safe,200) err,
    (xml LIKE '%PESOWISE_METADATA_JSON.LIST%') AS has_old_list_shape,
    length(xml) xml_len
  FROM tally_sync_delivery_batches
  WHERE job_id='${jobId}'
  ORDER BY batch_index
  LIMIT 5
) t;`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
