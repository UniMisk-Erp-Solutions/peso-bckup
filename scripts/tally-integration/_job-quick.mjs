#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
console.log(
  JSON.stringify(
    await sshPsqlJson(
      `SELECT jsonb_build_object(
        'job', (SELECT row_to_json(t) FROM (SELECT id, report_type, status, error_message_safe, prepared_item_count, created_at FROM tally_sync_jobs WHERE id='${jobId}') t),
        'batches', (SELECT jsonb_build_object(
          'pending', count(*) FILTER (WHERE status='pending'),
          'claimed', count(*) FILTER (WHERE status='claimed'),
          'delivered', count(*) FILTER (WHERE status='delivered'),
          'failed', count(*) FILTER (WHERE status='failed')
        ) FROM tally_sync_delivery_batches WHERE job_id='${jobId}'),
        'errors', (SELECT jsonb_agg(row_to_json(x)) FROM (
          SELECT batch_index, status, last_error_safe, left(tally_response_safe,250) tr
          FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND (status='failed' OR batch_index<2) ORDER BY batch_index LIMIT 5
        ) x)
      )`,
      { password: pass },
    ),
    null,
    2,
  ),
);
