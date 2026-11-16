#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'pending', (SELECT count(*)::int FROM tally_sync_delivery_batches b
    JOIN tally_sync_jobs j ON j.id = b.job_id WHERE j.organization_id='${ORG}' AND b.status='pending'),
  'waiting_jobs', (SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'report_type',report_type,'prepared',prepared_item_count))
    FROM tally_sync_jobs WHERE organization_id='${ORG}' AND status IN ('waiting_for_connector','delivering','prepared') LIMIT 5)
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
