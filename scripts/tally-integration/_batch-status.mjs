#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(b) ORDER BY batch_index) FROM (
  SELECT batch_index, status, message_count,
    left(COALESCE(tally_response_safe,''), 500) AS tally_response,
    left(COALESCE(last_error_safe,''), 200) AS last_error,
    (xml_payload LIKE '%PESOWISE_METADATA_JSON.LIST%') AS indexed_xml
  FROM tally_sync_delivery_batches WHERE job_id='${jobId}'
) b;`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
