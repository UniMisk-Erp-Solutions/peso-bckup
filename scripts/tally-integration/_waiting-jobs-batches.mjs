#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(t) ORDER BY t.created_at) FROM (
  SELECT j.id, j.report_type, j.status, j.created_at,
    (SELECT count(*)::int FROM tally_sync_delivery_batches b WHERE b.job_id=j.id AND b.status='pending') AS pending
  FROM tally_sync_jobs j
  WHERE j.organization_id='${ORG}' AND j.status IN ('waiting_for_connector','delivering')
) t;`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
