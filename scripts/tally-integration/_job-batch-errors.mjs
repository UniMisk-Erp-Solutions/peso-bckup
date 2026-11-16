#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2] || "838b5506-9843-4fc7-8ac1-75b8d4b4d6f5";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'summary', (
    SELECT jsonb_build_object(
      'pending', count(*) FILTER (WHERE status='pending'),
      'claimed', count(*) FILTER (WHERE status='claimed'),
      'delivered', count(*) FILTER (WHERE status='delivered'),
      'failed', count(*) FILTER (WHERE status='failed'),
      'skipped', count(*) FILTER (WHERE status='skipped')
    ) FROM tally_sync_delivery_batches WHERE job_id='${jobId}'
  ),
  'sample_errors', (
    SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT batch_index, status, last_error_safe, left(tally_response_safe, 200) AS tally_excerpt,
        ack_summary
      FROM tally_sync_delivery_batches
      WHERE job_id='${jobId}' AND status IN ('failed','delivered')
      ORDER BY batch_index LIMIT 8
    ) t
  ),
  'failed_count', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND status='failed')
);`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
