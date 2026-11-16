#!/usr/bin/env node
/**
 * READ ONLY — classify pending Tally jobs/batches (no mutations).
 *
 * Modes:
 *   REST (default): TALLY_VALIDATE_ADMIN_EMAIL + TALLY_VALIDATE_ADMIN_PASSWORD + anon key
 *   SSH (optional): DEPLOY_SSH_PASSWORD adds docker psql cross-check
 */
import { Client } from "ssh2";

const url = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(
  /\/$/,
  "",
);
const SMOKE_ORG = process.env.TALLY_SMOKE_ORG_ID ?? "80ab039f-f9e2-4c76-8b5b-e65b15d66af9";
const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const host = process.env.DEPLOY_SSH_HOST ?? "192.168.23.46";
const DB = process.env.DEPLOY_SUPABASE_DB_CONTAINER ?? "supabase-db-kar0ro1k6jiyfxzzw7acnsza";

/** PostgREST select lists — must match migrations (no updated_at on tally_sync_jobs). */
const JOBS_SELECT = [
  "id",
  "organization_id",
  "report_type",
  "status",
  "prepared_item_count",
  "created_at",
  "prepared_at",
  "started_at",
  "completed_at",
  "error_code",
  "error_message_safe",
  "dedupe_key",
  "config_snapshot",
  "parameters",
  "connector_device_id",
  "attempt_count",
].join(",");

const BATCHES_SELECT = [
  "id",
  "job_id",
  "organization_id",
  "batch_index",
  "message_count",
  "status",
  "attempt_count",
  "claimed_by",
  "claimed_at",
  "lease_expires_at",
  "created_at",
  "updated_at",
  "last_error_safe",
  "completed_at",
].join(",");

/** Explicit DB markers only — do not classify A from item count alone. */
const SMOKE_TEXT = /phase\s*5\.?1|smoke\s*isolation|smoke\s*batch|not for tally import|quarantine/i;

function fail(msg, code = 2) {
  console.log(JSON.stringify({ readonly: true, error: msg, hint: credentialHint() }, null, 2));
  process.exit(code);
}

function credentialHint() {
  return "Set TALLY_VALIDATE_ADMIN_EMAIL and TALLY_VALIDATE_ADMIN_PASSWORD (REST). Optional: DEPLOY_SSH_PASSWORD for SSH verify.";
}

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
  if (!res.ok) throw new Error(body.error_description ?? body.msg ?? `sign-in HTTP ${res.status}`);
  return body.access_token;
}

async function restGet(path, { anon, jwt }) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: anon, Authorization: `Bearer ${jwt}`, Accept: "application/json" },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`REST ${path}: non-JSON ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`REST ${path}: HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function classifyJob(job) {
  const markers = [];
  const text = [job.error_message_safe, job.error_code, JSON.stringify(job.config_snapshot ?? {})].join(" ");
  if (SMOKE_TEXT.test(text)) markers.push("explicit_smoke_text");
  if (markers.includes("explicit_smoke_text")) return { class: "A", markers, reason: "explicit Phase 5/smoke text in job record" };
  if (job.prepared_item_count >= 100) markers.push("prepared_item_count>=100");
  return {
    class: "C",
    markers,
    reason: markers.length ? "possible test volume but no explicit smoke marker" : "no smoke evidence",
  };
}

function classifyBatch(batch, job) {
  const text = [batch.last_error_safe, job?.error_message_safe].filter(Boolean).join(" ");
  if (SMOKE_TEXT.test(text)) return { class: "A", markers: ["explicit_smoke_text"], reason: "explicit smoke/isolation text" };
  if (job?.prepared_item_count >= 100) {
    return { class: "C", markers: ["job_prepared_item_count>=100"], reason: "large job; not marked A without explicit text" };
  }
  return { class: "C", markers: [], reason: "insufficient evidence for smoke or production" };
}

function summarizeJob(j, orgName) {
  const c = classifyJob(j);
  return {
    job_id: j.id,
    organization_id: j.organization_id,
    organization_name: orgName ?? null,
    report_type: j.report_type,
    status: j.status,
    prepared_item_count: j.prepared_item_count,
    created_at: j.created_at,
    prepared_at: j.prepared_at ?? null,
    started_at: j.started_at ?? null,
    completed_at: j.completed_at ?? null,
    error_code: j.error_code ?? null,
    error_message_safe: j.error_message_safe ?? null,
    dedupe_key: j.dedupe_key ?? null,
    config_report_type: j.config_snapshot?.report_type ?? j.config_snapshot?.reportType ?? null,
    is_smoke_org: j.organization_id === SMOKE_ORG,
    classification: c.class,
    classification_markers: c.markers,
    classification_reason: c.reason,
  };
}

function summarizeBatch(b, jobById, orgNames) {
  const job = jobById.get(b.job_id);
  const c = classifyBatch(b, job);
  return {
    batch_id: b.id,
    job_id: b.job_id,
    organization_id: b.organization_id,
    organization_name: orgNames.get(b.organization_id) ?? null,
    batch_index: b.batch_index,
    message_count: b.message_count,
    status: b.status,
    attempt_count: b.attempt_count,
    claimed_by: b.claimed_by,
    claimed_at: b.claimed_at ?? null,
    lease_expires_at: b.lease_expires_at ?? null,
    created_at: b.created_at,
    updated_at: b.updated_at,
    batch_completed_at: b.completed_at ?? null,
    last_error_safe: b.last_error_safe ?? null,
    job_status: job?.status ?? null,
    job_report_type: job?.report_type ?? null,
    job_prepared_item_count: job?.prepared_item_count ?? null,
    classification: c.class,
    classification_markers: c.markers,
    classification_reason: c.reason,
  };
}

async function fetchViaRest() {
  const email = process.env.TALLY_VALIDATE_ADMIN_EMAIL;
  const password = process.env.TALLY_VALIDATE_ADMIN_PASSWORD;
  if (!email || !password) fail("Missing TALLY_VALIDATE_ADMIN_EMAIL or TALLY_VALIDATE_ADMIN_PASSWORD");

  const anon = await loadAnonKey();
  const jwt = await signIn(anon, email, password);

  const jobStatuses = ["waiting_for_connector", "delivering", "prepared"];
  const jobs = await restGet(
    `tally_sync_jobs?status=in.(${jobStatuses.join(",")})&select=${JOBS_SELECT}&order=created_at.asc`,
    { anon, jwt },
  );
  if (!Array.isArray(jobs)) throw new Error(`unexpected jobs response: ${JSON.stringify(jobs).slice(0, 200)}`);

  const batches = await restGet(
    `tally_sync_delivery_batches?status=eq.pending&select=${BATCHES_SELECT}&order=created_at.asc`,
    { anon, jwt },
  );
  if (!Array.isArray(batches)) throw new Error(`unexpected batches response: ${JSON.stringify(batches).slice(0, 200)}`);

  const orgIds = [...new Set([...jobs, ...batches].map((r) => r.organization_id).filter(Boolean))];
  const orgNames = new Map();
  if (orgIds.length) {
    const inList = orgIds.join(",");
    const orgs = await restGet(`organizations?id=in.(${inList})&select=id,name`, { anon, jwt });
    if (Array.isArray(orgs)) for (const o of orgs) orgNames.set(o.id, o.name);
  }

  const jobById = new Map(jobs.map((j) => [j.id, j]));

  return {
    mode: "rest",
    pending_tally_jobs_count: jobs.length,
    pending_batches_count: batches.length,
    jobs: jobs.map((j) => summarizeJob(j, orgNames.get(j.organization_id))),
    batches: batches.map((b) => summarizeBatch(b, jobById, orgNames)),
    notes: {
      smoke_org_id: SMOKE_ORG,
      quarantine_script_filter:
        "list-and-quarantine-smoke-batches.mjs: single org + waiting_for_connector only → can return empty while global counts are 7/11",
      class_A_rule: "explicit Phase 5/smoke/quarantine text in safe error fields only",
    },
  };
}

async function sshCountsOptional() {
  if (!pass) return null;
  return new Promise((resolve) => {
    const conn = new Client();
    const sql = `SELECT jsonb_build_object('pending_batches',(SELECT count(*)::int FROM tally_sync_delivery_batches WHERE status='pending'),'pending_jobs',(SELECT count(*)::int FROM tally_sync_jobs WHERE status IN ('waiting_for_connector','delivering','prepared')));`;
    const bash = `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "${sql.replace(/"/g, '\\"')}"`;
    conn
      .on("ready", () => {
        conn.exec(bash, (err, stream) => {
          if (err) {
            conn.end();
            return resolve({ ssh_error: err.message });
          }
          let out = "";
          let errOut = "";
          stream.on("data", (d) => { out += d; });
          stream.stderr.on("data", (d) => { errOut += d; });
          stream.on("close", (code) => {
            conn.end();
            if (code !== 0) resolve({ ssh_error: errOut || out || `exit ${code}` });
            else {
              try {
                resolve({ ssh_db_counts: JSON.parse(out.trim()) });
              } catch {
                resolve({ ssh_error: "parse failed", raw: out.slice(0, 200) });
              }
            }
          });
        });
      })
      .on("error", (e) => resolve({ ssh_error: e.message }))
      .connect({ host, username: user, password: pass, readyTimeout: 20000 });
  });
}

async function main() {
  try {
    const result = await fetchViaRest();
    const sshExtra = await sshCountsOptional();
    console.log(JSON.stringify({ readonly: true, ...result, ssh: sshExtra }, null, 2));
    process.exit(0);
  } catch (e) {
    console.log(
      JSON.stringify(
        { readonly: true, error: e.message ?? String(e), hint: credentialHint() },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

main();
