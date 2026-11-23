#!/usr/bin/env node
/**
 * List pending smoke delivery batches, optionally quarantine via admin RPC.
 *
 * Env:
 *   TALLY_VALIDATE_SUPABASE_URL
 *   TALLY_VALIDATE_ADMIN_EMAIL / TALLY_VALIDATE_ADMIN_PASSWORD
 *   TALLY_VALIDATE_ANON_KEY (optional)
 *   QUARANTINE_CONFIRM=1  — call admin_quarantine_tally_delivery_batches_v1
 */
const ORG = process.env.TALLY_SMOKE_ORG_ID ?? "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
const url = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(/\/$/, "");

async function loadAnonKey() {
  if (process.env.TALLY_VALIDATE_ANON_KEY) return process.env.TALLY_VALIDATE_ANON_KEY;
  const t = await fetch("https://peso-backup.vercel.app/assets/index-Di3_NMzi.js").then((r) => r.text());
  const m = t.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!m) throw new Error("Set TALLY_VALIDATE_ANON_KEY");
  return m[0];
}

async function signIn(anon, email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? body.msg ?? res.status);
  return body.access_token;
}

async function rpc(name, args, { anon, jwt }) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${name}: ${text.slice(0, 400)}`);
  return data;
}

async function main() {
  const email = process.env.TALLY_VALIDATE_ADMIN_EMAIL;
  const password = process.env.TALLY_VALIDATE_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error("Set TALLY_VALIDATE_ADMIN_EMAIL and TALLY_VALIDATE_ADMIN_PASSWORD");
    process.exit(2);
  }
  const anon = await loadAnonKey();
  const jwt = await signIn(anon, email, password);

  const jobs = await fetch(
    `${url}/rest/v1/tally_sync_jobs?organization_id=eq.${ORG}&status=eq.waiting_for_connector&select=id,report_type,prepared_item_count,created_at&order=created_at.desc`,
    { headers: { apikey: anon, Authorization: `Bearer ${jwt}` } },
  ).then((r) => r.json());

  const jobIds = (Array.isArray(jobs) ? jobs : []).map((j) => j.id);
  if (!jobIds.length) {
    console.log(JSON.stringify({ pending_smoke_jobs: [], batches: [] }));
    return;
  }

  const inList = jobIds.map((id) => `"${id}"`).join(",");
  const batches = await fetch(
    `${url}/rest/v1/tally_sync_delivery_batches?job_id=in.(${inList})&status=eq.pending&select=id,job_id,batch_index,message_count,created_at`,
    { headers: { apikey: anon, Authorization: `Bearer ${jwt}` } },
  ).then((r) => r.json());

  console.log(JSON.stringify({ organization_id: ORG, jobs, pending_batches: batches }, null, 2));

  if (process.env.QUARANTINE_CONFIRM !== "1") {
    console.error("Dry run only. Set QUARANTINE_CONFIRM=1 to quarantine listed pending batch IDs via RPC.");
    return;
  }

  const batchIds = (Array.isArray(batches) ? batches : []).map((b) => b.id);
  if (!batchIds.length) return;

  const result = await rpc(
    "admin_quarantine_tally_delivery_batches_v1",
    {
      p_organization_id: ORG,
      p_batch_ids: batchIds,
      p_reason:
        "Superseded after Phase 5 metadata-voucher to metadata-ledger architecture migration; must not be delivered.",
    },
    { anon, jwt },
  );
  console.log(JSON.stringify({ quarantine_result: result }));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
