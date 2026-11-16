#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2] ?? "cf7b0cb0-e087-4371-a663-5c413d113f98";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(b) ORDER BY batch_index) FROM (
  SELECT batch_index, message_count, left(tally_response_safe, 400) AS tally_response
  FROM tally_sync_delivery_batches WHERE job_id = '${jobId}' LIMIT 5
) b;`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
