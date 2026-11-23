#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(b) ORDER BY batch_index) FROM (
  SELECT batch_index, status, message_count,
    (ack_summary->>'created')::int AS created,
    (ack_summary->>'altered')::int AS altered,
    left(last_error_safe, 120) AS err
  FROM tally_sync_delivery_batches WHERE job_id='${jobId}'
) b;`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
