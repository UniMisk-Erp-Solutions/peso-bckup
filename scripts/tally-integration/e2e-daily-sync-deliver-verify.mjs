#!/usr/bin/env node
/**
 * E2E: start daily sync (MicroLink) → deliver via local bridge → verify Tally metadata shape.
 */
import { loadBackupAnonKey } from "./_loadBackupAnonKey.mjs";
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const URL = "https://pesowise-backup-supabase.unimisk.com".replace(/\/$/, "");
const DATE_FROM = process.env.E2E_DATE_FROM ?? "2026-09-02";
const DATE_TO = process.env.E2E_DATE_TO ?? "2026-09-02";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function signIn(anon) {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@microlink.com", password: "qwertyui" }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? "sign-in failed");
  return body.access_token;
}

async function startSync(jwt, anon) {
  const res = await fetch(`${URL}/functions/v1/start-tally-sync`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      organization_id: ORG,
      report_type: "daily_project_report",
      parameters: { context_version: 1, date_from: DATE_FROM, date_to: DATE_TO },
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.job_id) throw new Error(JSON.stringify(data).slice(0, 300));
  return data.job_id;
}

async function jobSnapshot(jobId) {
  const pass = requireCoolifySshPassword();
  const sql = `
SELECT jsonb_build_object(
  'status', (SELECT status FROM tally_sync_jobs WHERE id='${jobId}'),
  'prepared', (SELECT prepared_item_count FROM tally_sync_jobs WHERE id='${jobId}'),
  'batches', (SELECT coalesce(jsonb_object_agg(status, c), '{}'::jsonb) FROM (
    SELECT status, count(*)::int c FROM tally_sync_delivery_batches WHERE job_id='${jobId}' GROUP BY status
  ) s),
  'pending', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND status='pending')
);`;
  return sshPsqlJson(sql, { password: pass });
}

async function waitPrepared(jobId, maxSec = 600) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxSec * 1000) {
    const s = await jobSnapshot(jobId);
    console.log("prepare", JSON.stringify(s));
    if (s.status === "waiting_for_connector" && Number(s.pending) > 0) return s;
    if (s.status === "completed") return s;
    if (s.status === "failed") throw new Error("job failed during prepare");
    await sleep(5000);
  }
  throw new Error("timeout waiting for batches");
}

async function deliverJob(jobId, maxSec = 900) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxSec * 1000) {
    const s = await jobSnapshot(jobId);
    if (s.status === "completed") return { ok: true, ...s };
    const batches = s.batches ?? {};
    const pending = Number(s.pending ?? 0);
    const failed = Number(batches.failed ?? 0);
    if (failed > 0 && pending === 0) return { ok: false, ...s, reason: "batch_failed" };
    if (pending > 0) {
      const r = await fetch("http://127.0.0.1:9876/v1/deliver-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      console.log("deliver-job", r.status, pending, "pending");
      await sleep(8000);
      continue;
    }
    if (s.status === "waiting_for_connector" && pending === 0 && !batches.delivered) {
      await sleep(3000);
      continue;
    }
    await sleep(4000);
  }
  return { ok: false, reason: "deliver_timeout" };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const bridge = await fetch("http://127.0.0.1:9876/v1/health")
  .then((r) => r.json())
  .catch(() => ({ ok: false }));
if (!bridge.ok) {
  console.error("Bridge down — start npm run dev first");
  process.exit(1);
}

spawnSync(process.execPath, ["scripts/tally-integration/sync-tdl-to-pesowise-folder.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
});

const anon = await loadBackupAnonKey();
const jwt = await signIn(anon);
console.log("=== start sync", DATE_FROM, DATE_TO, "===");
const jobId = await startSync(jwt, anon);
console.log("job_id", jobId);

await waitPrepared(jobId);
const deliver = await deliverJob(jobId);
console.log("=== deliver ===", deliver);

const probe = spawnSync(process.execPath, ["scripts/tally-integration/probe-meta-ledgers-export.mjs"], {
  cwd: ROOT,
  encoding: "utf-8",
});
console.log(probe.stdout);
if (probe.stderr) console.error(probe.stderr);

const final = await jobSnapshot(jobId);
const out = { job_id: jobId, bridge, deliver, final };
console.log(JSON.stringify(out, null, 2));
process.exit(deliver.ok && final.status === "completed" ? 0 : 1);
