#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const org = process.argv[2] ?? "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'job', (SELECT row_to_json(j) FROM (
    SELECT id, status, prepared_item_count, source_row_count, created_at, completed_at, error_message_safe
    FROM tally_sync_jobs
    WHERE organization_id = '${org}' AND report_type = 'daily_project_report'
    ORDER BY created_at DESC LIMIT 1
  ) j),
  'batches', (SELECT jsonb_object_agg(status, c) FROM (
    SELECT status, count(*)::int AS c FROM tally_sync_delivery_batches
    WHERE job_id = (SELECT id FROM tally_sync_jobs WHERE organization_id = '${org}' AND report_type = 'daily_project_report' ORDER BY created_at DESC LIMIT 1)
    GROUP BY status
  ) s),
  'sample_ack', (SELECT left(tally_response_safe, 200) FROM tally_sync_delivery_batches
    WHERE job_id = (SELECT id FROM tally_sync_jobs WHERE organization_id = '${org}' AND report_type = 'daily_project_report' ORDER BY created_at DESC LIMIT 1)
    ORDER BY batch_index LIMIT 1)
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
