#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(jsonb_build_object('seq', seq, 'payload_len', length(payload::text)) ORDER BY seq)
FROM tally_sync_job_items WHERE job_id = '${jobId}';
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
