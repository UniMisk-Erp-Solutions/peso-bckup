#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'total', (SELECT count(*)::int FROM tally_delivery_state WHERE organization_id='${ORG}'),
  'meta', (SELECT count(*)::int FROM tally_delivery_state WHERE organization_id='${ORG}' AND delivery_kind='report_metadata'),
  'sample', (SELECT jsonb_agg(jsonb_build_object('key',delivery_key,'remote',tally_remote_id,'kind',delivery_kind)) FROM (
    SELECT delivery_key, tally_remote_id, delivery_kind FROM tally_delivery_state WHERE organization_id='${ORG}' LIMIT 8
  ) t)
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
