#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `SELECT tally_response_safe FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND batch_index=0 LIMIT 1;`;
const row = await sshPsqlJson(sql, { password: pass });
console.log(typeof row === "string" ? row : JSON.stringify(row));
