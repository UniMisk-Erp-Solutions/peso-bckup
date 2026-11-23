#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `SELECT batch_index,status,attempt_count,max_attempts,last_error_safe FROM tally_sync_delivery_batches WHERE job_id='${jobId}' ORDER BY batch_index LIMIT 5`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
