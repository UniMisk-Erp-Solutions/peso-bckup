#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_agg(row_to_json(t) ORDER BY created_at DESC) FROM (
  SELECT id, status, prepared_item_count, source_row_count, created_at,
    (SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb) FROM (
      SELECT status, count(*)::int c FROM tally_sync_delivery_batches b WHERE b.job_id = tally_sync_jobs.id GROUP BY status
    ) s) AS batches
  FROM tally_sync_jobs
  WHERE organization_id='6709c1fe-e8c8-404d-bc68-d1edda923344'
    AND report_type='daily_project_report'
  ORDER BY created_at DESC LIMIT 10
) t;`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
