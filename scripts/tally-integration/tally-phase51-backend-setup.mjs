#!/usr/bin/env node
/**
 * Phase 5.1 backend prep from Tally PC (HTTPS only — no .46 SSH).
 *
 * Env:
 *   TALLY_VALIDATE_SUPABASE_URL (default backup public URL)
 *   TALLY_VALIDATE_ANON_KEY (optional — else read from peso-backup.vercel.app bundle)
 *   TALLY_VALIDATE_ADMIN_EMAIL / TALLY_VALIDATE_ADMIN_PASSWORD (required for admin RPCs)
 *   VALIDATE_SUPABASE_SERVICE_ROLE_KEY (required to isolate smoke delivery batches)
 */
const ORG = "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
const COMPANY = "PesoWise Integration Test";
const url = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(
  /\/$/,
  "",
);

async function loadAnonKey() {
  if (process.env.TALLY_VALIDATE_ANON_KEY) return process.env.TALLY_VALIDATE_ANON_KEY;
  const t = await fetch("https://peso-backup.vercel.app/assets/index-Di3_NMzi.js").then((r) => r.text());
  const m = t.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!m) throw new Error("Could not resolve publishable anon key (set TALLY_VALIDATE_ANON_KEY)");
  return m[0];
}

async function signIn(anon, email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Sign-in failed: ${body.error_description ?? body.msg ?? res.status}`);
  return body.access_token;
}

async function rpc(name, args, { anon, jwt }) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${jwt ?? anon}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

async function isolateSmokeBatches(serviceKey) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  const jobsRes = await fetch(
    `${url}/rest/v1/tally_sync_jobs?organization_id=eq.${ORG}&status=eq.waiting_for_connector&select=id,status,prepared_item_count&order=created_at.desc&limit=5`,
    { headers },
  );
  const jobs = await jobsRes.json();
  if (!jobsRes.ok) throw new Error(`list jobs: ${JSON.stringify(jobs)}`);
  const smoke = jobs.find((j) => j.prepared_item_count >= 100) ?? jobs[0];
  if (!smoke) {
    console.log("No waiting_for_connector smoke job found — nothing to isolate");
    return null;
  }
  const patchRes = await fetch(
    `${url}/rest/v1/tally_sync_delivery_batches?job_id=eq.${smoke.id}&status=eq.pending`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "skipped", last_error_safe: "Phase 5.1 smoke isolation (not for Tally import)" }),
    },
  );
  if (!patchRes.ok) throw new Error(`skip batches: ${await patchRes.text()}`);
  await fetch(`${url}/rest/v1/tally_sync_jobs?id=eq.${smoke.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      status: "failed",
      error_message_safe: "Phase 5.1 server smoke job isolated before real Tally validation",
    }),
  });
  return smoke.id;
}

async function main() {
  const email = process.env.TALLY_VALIDATE_ADMIN_EMAIL;
  const password = process.env.TALLY_VALIDATE_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("MANUAL ACTION: set TALLY_VALIDATE_ADMIN_EMAIL and TALLY_VALIDATE_ADMIN_PASSWORD");
    process.exit(2);
  }
  const anon = await loadAnonKey();
  const jwt = await signIn(anon, email, password);
  await rpc("set_tally_org_company_v1", { p_organization_id: ORG, p_tally_company_name: COMPANY }, { anon, jwt });
  const pairing = await rpc(
    "create_tally_connector_pairing_code_v1",
    { p_organization_id: ORG, p_ttl_minutes: 30 },
    { anon, jwt },
  );
  const svc = process.env.VALIDATE_SUPABASE_SERVICE_ROLE_KEY;
  let isolatedJob = null;
  if (svc) isolatedJob = await isolateSmokeBatches(svc);
  else console.warn("VALIDATE_SUPABASE_SERVICE_ROLE_KEY unset — smoke batches NOT isolated");

  const code = String(pairing?.pairing_code ?? "");
  console.log(
    JSON.stringify({
      organization_id: ORG,
      tally_company: COMPANY,
      pairing_code_prefix: code ? `${code.slice(0, 4)}****` : null,
      isolated_smoke_job_id: isolatedJob,
    }),
  );
  if (process.env.TALLY_PHASE51_EMIT_PAIRING === "1" && code) {
    console.error(`PAIRING_CODE=${code}`);
  } else if (code) {
    console.error("Pairing code created (not logged). Re-run with TALLY_PHASE51_EMIT_PAIRING=1 to print once.");
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
