#!/usr/bin/env node
/**
 * Smoke: start each report_type sync (MicroLink), wait for batches or fail fast.
 * Env: optional SKIP_HEAVY=1 to skip claim_* full org syncs.
 */
import { loadBackupAnonKey } from "./_loadBackupAnonKey.mjs";
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const ORG = "6709c1fe-e8c8-404d-bc68-d1edda923344";
const url = "https://pesowise-backup-supabase.unimisk.com".replace(/\/$/, "");
const expectedCompany = "PesoWise Integration Test";

if (process.env.RUN_MICROLINK_SYNC_SMOKE !== "1") {
  throw new Error(
    "This smoke run creates jobs from existing MicroLink data. Set RUN_MICROLINK_SYNC_SMOKE=1 only for an explicitly authorized isolated-company test.",
  );
}
const adminEmail = process.env.TALLY_VALIDATE_ADMIN_EMAIL;
const adminPassword = process.env.TALLY_VALIDATE_ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  throw new Error(
    "Set TALLY_VALIDATE_ADMIN_EMAIL and TALLY_VALIDATE_ADMIN_PASSWORD in the process environment; credentials are not embedded in this script.",
  );
}

const bridgeStatus = await fetch("http://127.0.0.1:9876/v1/status").then((r) => r.json());
if (
  bridgeStatus.connector_paired !== true ||
  bridgeStatus.organization_id !== ORG ||
  bridgeStatus.tally_company_verified !== true ||
  bridgeStatus.tally_company_verified_name !== expectedCompany ||
  bridgeStatus.delivery_in_progress === true
) {
  throw new Error("Local connector is not safely paired to MicroLink and the isolated PesoWise Integration Test company.");
}

async function signIn(anon) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? "sign-in failed");
  return body.access_token;
}

async function startSync(jwt, anon, reportType, parameters) {
  const res = await fetch(`${url}/functions/v1/start-tally-sync`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ organization_id: ORG, report_type: reportType, parameters }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${reportType} start ${res.status}: ${text.slice(0, 200)}`);
  return data.job_id;
}

async function jobSnapshot(jobId) {
  const pass = requireCoolifySshPassword();
  const sql = `
SELECT jsonb_build_object(
  'status', (SELECT status FROM tally_sync_jobs WHERE id='${jobId}'),
  'prepared', (SELECT prepared_item_count FROM tally_sync_jobs WHERE id='${jobId}'),
  'batches', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}'),
  'pending', (SELECT count(*)::int FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND status='pending')
);`;
  return sshPsqlJson(sql, { password: pass });
}

async function waitJob(jobId, label, maxSec = 900) {
  const started = Date.now();
  while (Date.now() - started < maxSec * 1000) {
    const s = await jobSnapshot(jobId);
    console.log(JSON.stringify({ step: label, job_id: jobId, ...s }));
    if (s.status === "waiting_for_connector" && s.batches > 0) return { ok: true, ...s };
    if (s.status === "completed" && s.batches > 0) return { ok: true, completed: true, ...s };
    if (s.status === "failed") return { ok: false, ...s };
    if (s.status === "completed" && s.batches === 0 && (s.prepared === 0 || s.prepared == null)) {
      return { ok: true, empty: true, ...s };
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  return { ok: false, timeout: true };
}

const cases = [
  {
    report_type: "daily_project_report",
    parameters: { context_version: 1, date_from: "2026-09-02", date_to: "2026-09-02" },
  },
  {
    report_type: "detailed_expense",
    parameters: { context_version: 1, year: "2026", month: "09" },
  },
  ...(process.env.SKIP_HEAVY === "1"
    ? []
    : [
        { report_type: "claim_verification", parameters: { context_version: 1 } },
        { report_type: "claim_approval", parameters: { context_version: 1 } },
      ]),
];

const anon = await loadBackupAnonKey();
const jwt = await signIn(anon);
const results = [];

for (const c of cases) {
  try {
    const jobId = await startSync(jwt, anon, c.report_type, c.parameters);
    const fin = await waitJob(jobId, c.report_type, c.report_type.includes("claim") ? 600 : 420);
    results.push({ report_type: c.report_type, job_id: jobId, ...fin });
  } catch (e) {
    results.push({ report_type: c.report_type, ok: false, error: e.message });
  }
}

const bridge = await fetch("http://127.0.0.1:9876/v1/status").then((r) => r.json()).catch(() => ({ ok: false }));
console.log(JSON.stringify({ bridge, results }, null, 2));
const allOk = results.every((r) => r.ok !== false);
process.exit(allOk ? 0 : 1);
