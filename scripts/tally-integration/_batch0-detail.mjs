#!/usr/bin/env node
import { sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const jobId = process.argv[2] || "838b5506-9843-4fc7-8ac1-75b8d4b4d6f5";
const pass = requireCoolifySshPassword();
const sql = `SELECT batch_index, status, attempt_count, last_error_safe, ack_summary::text, left(tally_response_safe,300) FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND batch_index=0`;
// use mutate doesn't return rows - use json from psql
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
console.log(await sshPsqlJson(`SELECT jsonb_agg(row_to_json(t)) FROM (SELECT batch_index, status, attempt_count, last_error_safe, ack_summary, left(tally_response_safe,400) tr FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND batch_index<=1 ORDER BY batch_index) t`, { password: pass }));
