#!/usr/bin/env node
/**
 * Smoke org: enqueue + dispatch Daily Project Report via start-tally-sync (admin JWT).
 *
 * Env: TALLY_VALIDATE_ADMIN_EMAIL, TALLY_VALIDATE_ADMIN_PASSWORD
 * Optional: TALLY_SMOKE_ORG_ID, TALLY_VALIDATE_SUPABASE_URL, poll via REST
 */
import { loadBackupAnonKey } from "./_loadBackupAnonKey.mjs";

const ORG = process.env.TALLY_SMOKE_ORG_ID ?? "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
const url = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(
  /\/$/,
  "",
);

async function signIn(anon, email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? body.msg ?? `sign-in HTTP ${res.status}`);
  return body.access_token;
}

async function startSync(jwt, anon) {
  const res = await fetch(`${url}/functions/v1/start-tally-sync`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      organization_id: ORG,
      report_type: "daily_project_report",
      parameters: {
        context_version: 1,
        ...(process.env.TALLY_E2E_CONTROLLED_SINGLE_METADATA === "1"
          ? { e2e_controlled_single_metadata: true }
          : {}),
        ...(process.env.TALLY_DAILY_DATE_FROM
          ? { date_from: process.env.TALLY_DAILY_DATE_FROM, date_to: process.env.TALLY_DAILY_DATE_TO ?? process.env.TALLY_DAILY_DATE_FROM }
          : {}),
      },
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`start-tally-sync non-JSON ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`start-tally-sync HTTP ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

async function pollJob(jobId, jwt, anon, maxSec = 600) {
  const select =
    "id,status,prepared_item_count,error_code,error_message_safe,connector_device_id,prepared_at,completed_at";
  const started = Date.now();
  while (Date.now() - started < maxSec * 1000) {
    const res = await fetch(
      `${url}/rest/v1/tally_sync_jobs?id=eq.${jobId}&select=${encodeURIComponent(select)}`,
      { headers: { apikey: anon, Authorization: `Bearer ${jwt}`, Accept: "application/json" } },
    );
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) throw new Error(`job ${jobId} not visible via REST`);
    const snap = {
      job_id: jobId,
      status: row.status,
      prepared_item_count: row.prepared_item_count,
      connector_device_id: row.connector_device_id,
      error_code: row.error_code,
      error_message_safe: row.error_message_safe,
    };
    console.log(JSON.stringify({ poll: snap }));
    if (row.status === "waiting_for_connector" || row.status === "completed" || row.status === "failed") {
      return row;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`poll timeout after ${maxSec}s for job ${jobId}`);
}

async function main() {
  const email = process.env.TALLY_VALIDATE_ADMIN_EMAIL;
  const password = process.env.TALLY_VALIDATE_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(JSON.stringify({ error: "Set TALLY_VALIDATE_ADMIN_EMAIL and TALLY_VALIDATE_ADMIN_PASSWORD" }));
    process.exit(2);
  }
  const anon = await loadBackupAnonKey();
  const jwt = await signIn(anon, email, password);
  const started = await startSync(jwt, anon);
  const jobId = started?.job_id ?? started?.id;
  if (!jobId) {
    console.log(JSON.stringify({ started }, null, 2));
    throw new Error("No job_id in start-tally-sync response");
  }
  const final = await pollJob(jobId, jwt, anon);
  const ok = final.status === "waiting_for_connector" || final.status === "completed";
  console.log(
    JSON.stringify(
      {
        organization_id: ORG,
        report_type: "daily_project_report",
        job_id: jobId,
        final_status: final.status,
        ready_for_agent: final.status === "waiting_for_connector",
        success: ok,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
