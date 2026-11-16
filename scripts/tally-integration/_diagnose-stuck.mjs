#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const jobId = process.argv[2];
const pass = requireCoolifySshPassword();

const sql = jobId
  ? `SELECT jsonb_build_object(
      'job', (SELECT row_to_json(t) FROM (SELECT * FROM tally_sync_jobs WHERE id='${jobId}') t),
      'batches', (SELECT jsonb_agg(row_to_json(b) ORDER BY batch_index) FROM (
        SELECT batch_index, status, message_count, attempt_count, last_error_safe, left(xml_payload,80) xml_start
        FROM tally_sync_delivery_batches WHERE job_id='${jobId}'
      ) b)
    )`
  : `SELECT jsonb_build_object(
      'waiting', (SELECT jsonb_agg(row_to_json(t) ORDER BY created_at DESC) FROM (
        SELECT j.id, j.report_type, j.status, j.prepared_item_count, j.created_at,
          (SELECT count(*)::int FROM tally_sync_delivery_batches b WHERE b.job_id=j.id) batches_total,
          (SELECT count(*)::int FROM tally_sync_delivery_batches b WHERE b.job_id=j.id AND b.status='pending') pending,
          (SELECT count(*)::int FROM tally_sync_delivery_batches b WHERE b.job_id=j.id AND b.status='delivered') delivered,
          (SELECT count(*)::int FROM tally_sync_delivery_batches b WHERE b.job_id=j.id AND b.status='failed') failed
        FROM tally_sync_jobs j WHERE j.organization_id='${ORG}' AND j.status='waiting_for_connector'
        ORDER BY j.created_at DESC LIMIT 8
      ) t),
      'oldest_pending_batch', (
        SELECT row_to_json(x) FROM (
          SELECT b.id, b.job_id, b.batch_index, b.status, j.report_type, j.created_at
          FROM tally_sync_delivery_batches b
          JOIN tally_sync_jobs j ON j.id = b.job_id
          WHERE b.organization_id='${ORG}' AND b.status='pending' AND j.status IN ('waiting_for_connector','delivering')
          ORDER BY j.created_at DESC, b.batch_index ASC LIMIT 1
        ) x
      ),
      'devices', (SELECT jsonb_agg(row_to_json(d)) FROM (
        SELECT id, device_name, last_seen_at, connector_version, revoked_at FROM tally_connector_devices
        WHERE organization_id='${ORG}' ORDER BY last_seen_at DESC NULLS LAST
      ) d)
    )`;

console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
