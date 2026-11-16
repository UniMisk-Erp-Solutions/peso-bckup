#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(t) ORDER BY batch_index) FROM (
  SELECT batch_index, status, attempt_count, last_error_safe, left(tally_response_safe, 400) AS tally_excerpt
  FROM tally_sync_delivery_batches WHERE job_id = '${jobId}'
) t;
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
