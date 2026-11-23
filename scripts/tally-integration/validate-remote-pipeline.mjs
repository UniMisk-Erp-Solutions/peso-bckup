#!/usr/bin/env node
/**
 * Phase 3.5 remote checks (read-only). Requires env:
 *   VALIDATE_SUPABASE_URL
 *   VALIDATE_SUPABASE_SERVICE_ROLE_KEY  (never commit)
 *
 * Usage:
 *   node scripts/tally-integration/validate-remote-pipeline.mjs
 */
const url = process.env.VALIDATE_SUPABASE_URL?.replace(/\/$/, "");
const svc = process.env.VALIDATE_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !svc) {
  console.error("Set VALIDATE_SUPABASE_URL and VALIDATE_SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const headers = {
  apikey: svc,
  Authorization: `Bearer ${svc}`,
  "Content-Type": "application/json",
};

async function rest(path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  return { status: r.status, body: await r.text() };
}

async function rpc(name, body) {
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, body: await r.text() };
}

async function main() {
  const out = { url, at: new Date().toISOString(), checks: {} };

  out.checks.tally_sync_jobs = await rest("tally_sync_jobs?select=id,status&limit=1");
  out.checks.tally_sync_job_items = await rest("tally_sync_job_items?select=id&limit=1");
  out.checks.claim_rpc = await rpc("claim_tally_sync_job_v1", {
    p_worker_id: "validate-probe",
    p_job_id: null,
  });
  out.checks.worker = await fetch(`${url}/functions/v1/run-tally-sync-job`, {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${svc}` },
    body: "{}",
  }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 500) }));

  out.checks.start_tally = await fetch(`${url}/functions/v1/start-tally-sync`, {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${svc}` },
    body: JSON.stringify({ organization_id: "00000000-0000-0000-0000-000000000000", report_type: "claim_verification", parameters: {} }),
  }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 500) }));

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
