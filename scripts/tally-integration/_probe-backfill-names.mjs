#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const limit = 5;
const sql = `
SELECT jsonb_agg(tally_remote_id) AS names FROM (
  SELECT DISTINCT tally_remote_id
  FROM tally_delivery_state
  WHERE organization_id = '${ORG}'
    AND delivery_kind = 'report_metadata'
    AND delivery_key LIKE '%meta:daily_project_report%'
    AND tally_remote_id IS NOT NULL
    AND tally_remote_id LIKE 'PW-META%'
  ORDER BY tally_remote_id
  LIMIT ${limit}
) s;`;
console.log(await sshPsqlJson(sql, { password: requireCoolifySshPassword() }));
