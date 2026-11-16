#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2] ?? "3a4f4614-bb4f-4b79-a2e4-ebaecd658339";
const pass = requireCoolifySshPassword();
const sql = `
SELECT jsonb_build_object(
  'job_id', '${jobId}',
  'batches', count(*)::int,
  'delivered', count(*) FILTER (WHERE status = 'delivered')::int,
  'skipped', count(*) FILTER (WHERE status = 'skipped')::int,
  'with_dpr_track', count(*) FILTER (WHERE xml_payload LIKE '%PESOWISE_DPR_TRACK_DATE%')::int,
  'with_flat_row', count(*) FILTER (WHERE xml_payload LIKE '%PESOWISE_REPORT_FLAT_ROW%')::int,
  'sum_created', coalesce(sum((ack_summary->>'created')::int), 0),
  'sum_altered', coalesce(sum((ack_summary->>'altered')::int), 0),
  'exc_batches', count(*) FILTER (WHERE tally_response_safe LIKE '%<EXCEPTIONS>%' AND tally_response_safe NOT LIKE '%<CREATED>1%')::int
) FROM tally_sync_delivery_batches WHERE job_id = '${jobId}';`;
console.log(JSON.stringify(await sshPsqlJson(sql, { password: pass }), null, 2));
