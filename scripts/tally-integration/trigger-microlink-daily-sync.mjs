#!/usr/bin/env node
/**
 * MicroLink org: start Daily Project sync + poll until waiting_for_connector or completed.
 * Bridge on 127.0.0.1:9876 must deliver batches after that.
 */
import { loadBackupAnonKey } from "./_loadBackupAnonKey.mjs";
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const url = "https://pesowise-backup-supabase.unimisk.com".replace(/\/$/, "");

const dateFrom = process.env.TALLY_DAILY_DATE_FROM ?? "2026-09-02";
const dateTo = process.env.TALLY_DAILY_DATE_TO ?? dateFrom;

async function signIn(anon) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@microlink.com", password: "qwertyui" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? "sign-in failed");
  return body.access_token;
}

async function startSync(jwt, anon) {
  const res = await fetch(`${url}/functions/v1/start-tally-sync`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      organization_id: ORG,
      report_type: "daily_project_report",
      parameters: { context_version: 1, date_from: dateFrom, date_to: dateTo },
    }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`start ${res.status}: ${text.slice(0, 300)}`);
  return data.job_id ?? data.job?.id ?? data.id;
}

async function jobSnapshot(jobId) {
  const pass = requireCoolifySshPassword();
  const sql = `
SELECT jsonb_build_object(
  'status', (SELECT status FROM tally_sync_jobs WHERE id='${jobId}'),
  'prepared', (SELECT prepared_item_count FROM tally_sync_jobs WHERE id='${jobId}'),
  'batches', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}'),
  'pending', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND status='pending'),
  'delivered', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND status='delivered')
);`;
  return sshPsqlJson(sql, { password: pass });
}

async function main() {
  const anon = await loadBackupAnonKey();
  const jwt = await signIn(anon);
  const jobId = await startSync(jwt, anon);
  console.log(JSON.stringify({ job_id: jobId, date_from: dateFrom, date_to: dateTo }));

  const started = Date.now();
  while (Date.now() - started < 600_000) {
    const s = await jobSnapshot(jobId);
    console.log(JSON.stringify({ poll: s }));
    if (s.status === "waiting_for_connector" && s.batches > 0) {
      console.log(JSON.stringify({ ready_for_bridge: true, job_id: jobId }));
      return;
    }
    if (s.status === "completed") {
      console.log(JSON.stringify({ completed: true, job_id: jobId, ...s }));
      return;
    }
    if (s.status === "failed") throw new Error(`job failed: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("timeout waiting for batches");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
