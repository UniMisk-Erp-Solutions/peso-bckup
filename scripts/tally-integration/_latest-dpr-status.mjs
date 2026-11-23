#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'job', (SELECT row_to_json(t) FROM (
    SELECT id, status, created_at, prepared_item_count FROM tally_sync_jobs
    WHERE organization_id='${ORG}' AND report_type='daily_project_report'
    ORDER BY created_at DESC LIMIT 1
  ) t),
  'batches', (SELECT jsonb_build_object(
    'pending', count(*) FILTER (WHERE status='pending'),
    'claimed', count(*) FILTER (WHERE status='claimed'),
    'delivered', count(*) FILTER (WHERE status='delivered'),
    'failed', count(*) FILTER (WHERE status='failed')
  ) FROM tally_sync_delivery_batches WHERE job_id=(
    SELECT id FROM tally_sync_jobs WHERE organization_id='${ORG}' AND report_type='daily_project_report'
    ORDER BY created_at DESC LIMIT 1
  ))
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
