#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const orgId = process.argv[2] ?? "6709c1fe-e8c8-404d-bc68-d1edda923344";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'job', (SELECT row_to_json(t) FROM (
    SELECT id, status, prepared_item_count, error_message_safe, created_at
    FROM tally_sync_jobs
    WHERE organization_id = '${orgId}' AND report_type = 'daily_project_report'
    ORDER BY created_at DESC LIMIT 1
  ) t),
  'batches_by_status', (
    SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
    FROM (
      SELECT b.status, count(*)::int AS c
      FROM tally_sync_delivery_batches b
      JOIN tally_sync_jobs j ON j.id = b.job_id
      WHERE j.organization_id = '${orgId}' AND j.report_type = 'daily_project_report'
        AND j.id = (
          SELECT id FROM tally_sync_jobs
          WHERE organization_id = '${orgId}' AND report_type = 'daily_project_report'
          ORDER BY created_at DESC LIMIT 1
        )
      GROUP BY b.status
    ) s
  )
);
`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
