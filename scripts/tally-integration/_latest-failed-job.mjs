#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'failed_jobs', (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC)
    FROM (
      SELECT id, report_type, status, error_code, error_message_safe, prepared_item_count, created_at, completed_at
      FROM tally_sync_jobs
      WHERE organization_id='${ORG}' AND status='failed'
      ORDER BY created_at DESC LIMIT 3
    ) t
  ),
  'latest_any', (
    SELECT row_to_json(t) FROM (
      SELECT id, report_type, status, error_code, error_message_safe, prepared_item_count, created_at
      FROM tally_sync_jobs WHERE organization_id='${ORG}' AND report_type='daily_project_report'
      ORDER BY created_at DESC LIMIT 1
    ) t
  )
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
