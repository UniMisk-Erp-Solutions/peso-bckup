#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const idx = process.argv[3] ?? "3";
const pass = requireCoolifySshPassword();
const sql = `SELECT left(xml_payload, 4000) AS snippet FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND batch_index=${idx};`;
const row = await sshPsqlJson(sql, { password: pass });
console.log(row?.snippet ?? row);
