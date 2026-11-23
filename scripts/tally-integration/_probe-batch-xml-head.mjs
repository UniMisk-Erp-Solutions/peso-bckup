#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const idx = process.argv[3] ?? "0";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'batch_index', batch_index,
  'message_count', message_count,
  'has_employees', position('PesoWise Employees' in xml_payload) > 0,
  'head', left(xml_payload, 700)
) FROM tally_sync_delivery_batches
WHERE job_id = '${jobId}' AND batch_index = ${idx}::int;
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
