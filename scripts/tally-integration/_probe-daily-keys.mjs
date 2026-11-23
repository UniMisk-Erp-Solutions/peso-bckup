#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const sql = `
SELECT jsonb_build_object(
  'daily', (SELECT count(*)::int FROM tally_delivery_state WHERE organization_id='${ORG}' AND delivery_key LIKE '%daily_project_report%'),
  'daily_row', (SELECT count(*)::int FROM tally_delivery_state WHERE organization_id='${ORG}' AND delivery_key LIKE '%daily_row%'),
  'samples', (SELECT jsonb_agg(delivery_key) FROM (SELECT delivery_key FROM tally_delivery_state WHERE organization_id='${ORG}' AND delivery_key LIKE '%daily%' LIMIT 5) t),
  'with_remote', (SELECT count(*)::int FROM tally_delivery_state WHERE organization_id='${ORG}' AND delivery_key LIKE '%daily_project_report%' AND tally_remote_id IS NOT NULL),
  'sample_remote', (SELECT tally_remote_id FROM tally_delivery_state WHERE organization_id='${ORG}' AND delivery_key LIKE '%daily_project_report%' AND tally_remote_id IS NOT NULL LIMIT 1)
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: requireCoolifySshPassword() }), null, 2));
