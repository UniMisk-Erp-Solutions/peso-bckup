#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const pass = requireCoolifySshPassword();
const sql = (extra = "") => `
SELECT jsonb_build_object(
  'status', (SELECT status FROM tally_sync_jobs WHERE id='${jobId}'),
  'prepared', (SELECT prepared_item_count FROM tally_sync_jobs WHERE id='${jobId}'),
  'source_rows', (SELECT source_row_count FROM tally_sync_jobs WHERE id='${jobId}'),
  'error', (SELECT error_message_safe FROM tally_sync_jobs WHERE id='${jobId}'),
  'batches', (SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb) FROM (
    SELECT status, count(*)::int c FROM tally_sync_delivery_batches WHERE job_id='${jobId}' GROUP BY status
  ) s),
  'pending', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND status='pending')
  ${extra}
);`;

async function snap() {
  return sshPsqlJson(sql(), { password: pass });
}

const t0 = Date.now();
while (Date.now() - t0 < 900_000) {
  const s = await snap();
  console.log(new Date().toISOString(), JSON.stringify(s));
  if (s.status === "completed") {
    console.log("DONE completed");
    process.exit(0);
  }
  if (s.status === "failed") {
    console.error("FAILED", s.error);
    process.exit(1);
  }
  if (s.status === "waiting_for_connector" && Number(s.pending) > 0) {
    await fetch("http://127.0.0.1:9876/v1/deliver-job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
  }
  if (s.status === "waiting_for_connector" && Number(s.pending) === 0 && s.batches?.delivered) {
    console.log("DONE all batches delivered");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 6000));
}
process.exit(2);
