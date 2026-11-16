#!/usr/bin/env node
/**
 * Controlled metadata E2E: deploy stack → queue safe → TCP 9000 → one sync job → run-once → verify.
 * Requires DEPLOY_SSH_PASSWORD (or DEPLOY_SSH_PASSWORD_FILE). No Tally HTTP except Agent run-once.
 */
import { spawnSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Client } from "ssh2";
import { evaluateQueueSafe, QUEUE_SNAPSHOT_SQL, SMOKE_ORG } from "./_queueSafeShared.mjs";
import { sshPsqlJson, requireSshPassword, DEFAULT_HOST, DEFAULT_USER, DEFAULT_DB } from "./_sshPsqlRemote.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const URL = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(
  /\/$/,
  "",
);
const KONG = process.env.DEPLOY_KONG_CONTAINER ?? "supabase-kong-kar0ro1k6jiyfxzzw7acnsza";
const SMOKE_ADMIN = "7316914e-f8a8-49cb-808f-f549a56e668d";
const AGENT_EXE = join(ROOT, "connector/tally/dist/PesoWise-Tally-Agent.exe");
const CONFIG_PATH = process.env.PESO_TALLY_CONFIG ?? "C:\\Users\\admin\\PesoWise\\TallyConnector\\config.json";
const QUARANTINE_SKIPPED_EXPECT = 7;

function fail(msg) {
  console.log(JSON.stringify({ result: "E2E STOPPED", reason: msg }, null, 2));
  process.exit(1);
}

function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let errOut = "";
      stream.on("data", (d) => {
        out += d;
      });
      stream.stderr.on("data", (d) => {
        errOut += d;
      });
      stream.on("close", (code) => {
        if (code !== 0) reject(new Error(errOut || out || `exit ${code}`));
        else resolve(out);
      });
    });
  });
}

async function sshConnect(pass) {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on("ready", resolve).on("error", reject).connect({
      host: DEFAULT_HOST,
      username: DEFAULT_USER,
      password: pass,
      readyTimeout: 30000,
    });
  });
  return conn;
}

async function getServiceRoleKey(conn) {
  const key = await sshExec(conn, `docker exec ${KONG} printenv SUPABASE_SERVICE_ROLE_KEY | tr -d '\\r'`);
  if (!key.startsWith("eyJ")) throw new Error("Could not read SUPABASE_SERVICE_ROLE_KEY from Kong");
  return key.trim();
}

async function findSingleDailyDate(srk, orgId) {
  const config = { daily_expense_report_config: {} };
  const today = new Date();
  for (let i = 0; i < 120; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const res = await fetch(`${URL}/rest/v1/rpc/report_daily_project_rows_v1`, {
      method: "POST",
      headers: {
        apikey: srk,
        Authorization: `Bearer ${srk}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_organization_id: orgId,
        p_config: config,
        p_date_from: iso,
        p_date_to: iso,
        p_user_id: null,
        p_user_ids: null,
        p_snapshot_at: null,
        p_cursor: null,
        p_page_size: 10,
        p_with_total: true,
      }),
    });
    if (!res.ok) continue;
    const p = await res.json();
    const total = p.total_count == null ? null : Number(p.total_count);
    if (total === 1) return iso;
  }
  throw new Error("No single-row daily date found in last 120 days for smoke org");
}

async function createControlledJob(conn, srk, dateFrom) {
  const params = JSON.stringify({
    context_version: 1,
    e2e_controlled_single_metadata: true,
    date_from: dateFrom,
    date_to: dateFrom,
  });
  const dedupe = `e2e-controlled-${Date.now()}`;
  const bash = `set -e
DB=${DEFAULT_DB}
JOB=$(docker exec $DB psql -U supabase_admin -d postgres -q -t -A -c \\
  "WITH ins AS (INSERT INTO tally_sync_jobs (organization_id,requested_by,report_type,parameters,dedupe_key,status) VALUES ('${SMOKE_ORG}','${SMOKE_ADMIN}','daily_project_report','${params.replace(/'/g, "''")}'::jsonb,'${dedupe}','queued') RETURNING id) SELECT id FROM ins;" | tr -d '[:space:]')
echo "JOB_ID=$JOB"
curl -s -X POST "${URL}/functions/v1/run-tally-sync-job" \\
  -H "Authorization: Bearer ${srk}" -H "Content-Type: application/json" \\
  -d "{\\"job_id\\":\\"$JOB\\"}"
echo
for i in $(seq 1 90); do
  ROW=$(docker exec $DB psql -U supabase_admin -d postgres -tAc \\
    "SELECT status||'|'||COALESCE(prepared_item_count::text,'') FROM tally_sync_jobs WHERE id='$JOB';")
  echo "poll $i $ROW"
  ST=$(echo "$ROW" | cut -d'|' -f1)
  if [ "$ST" = "prepared" ] || [ "$ST" = "waiting_for_connector" ] || [ "$ST" = "failed" ]; then break; fi
  sleep 4
done
curl -s -X POST "${URL}/functions/v1/run-tally-sync-delivery" \\
  -H "Authorization: Bearer ${srk}" -H "Content-Type: application/json" \\
  -d "{\\"job_id\\":\\"$JOB\\"}"
echo
sleep 2
BATCH=$(docker exec $DB psql -U supabase_admin -d postgres -tAc \\
  "SELECT id||'|'||status||'|'||message_count::text FROM tally_sync_delivery_batches WHERE job_id='$JOB' ORDER BY batch_index LIMIT 1;" | tr -d '[:space:]')
echo "BATCH_ROW=$BATCH"
`;
  const out = await sshExec(conn, bash);
  const jobMatch = out.match(/JOB_ID=([0-9a-f-]{36})/i);
  const batchMatch = out.match(/BATCH_ROW=([0-9a-f-]{36})\|([^|]+)\|(\d+)/i);
  if (!jobMatch) throw new Error(`job create failed: ${out.slice(-800)}`);
  if (!batchMatch) throw new Error(`batch missing: ${out.slice(-800)}`);
  return {
    job_id: jobMatch[1],
    batch_id: batchMatch[1],
    batch_status: batchMatch[2],
    message_count: Number(batchMatch[3]),
    log: out,
  };
}

async function fetchJobBatchSnapshot(pass, jobId, batchId) {
  const sql = `
SELECT jsonb_build_object(
  'job', (SELECT row_to_json(j) FROM (
    SELECT id, organization_id, report_type, status, parameters, prepared_item_count
    FROM public.tally_sync_jobs WHERE id = '${jobId}'::uuid
  ) j),
  'batch', (SELECT row_to_json(b) FROM (
    SELECT id, job_id, organization_id, status, message_count, batch_index
    FROM public.tally_sync_delivery_batches WHERE id = '${batchId}'::uuid
  ) b)
);
`;
  return sshPsqlJson(sql, { password: pass });
}

function tcp9000Ok() {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", "(Test-NetConnection -ComputerName 127.0.0.1 -Port 9000 -WarningAction SilentlyContinue).TcpTestSucceeded"],
    { encoding: "utf-8" },
  );
  return r.stdout.trim().toLowerCase() === "true";
}

async function main() {
  let pass;
  try {
    pass = requireSshPassword();
  } catch {
    fail("Coolify SSH not configured (COOLIFY_SSH_PASSWORD or .local-sensitive-data/coolify_ssh_password.txt)");
  }

  if (process.env.SKIP_DEPLOY !== "1") {
    console.log("=== STEP: deploy Coolify edge + e2e migration ===");
    const deploy = spawnSync(process.execPath, ["scripts/tally-integration/deploy-e2e-controlled-stack.mjs"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: process.env,
    });
    process.stdout.write(deploy.stdout || "");
    process.stderr.write(deploy.stderr || "");
    if (deploy.status !== 0) fail("deploy-e2e-controlled-stack failed");
  } else {
    console.log("=== STEP: SKIP_DEPLOY=1 (stack already deployed) ===");
  }

  console.log("=== STEP: edge boot probe ===");
  const probe = spawnSync(process.execPath, ["scripts/tally-integration/probe-backup-edge-functions.mjs"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  process.stdout.write(probe.stdout || "");
  process.stderr.write(probe.stderr || "");
  if (probe.status !== 0) fail("edge boot probe failed");

  console.log("=== STEP: queue safety (pre) ===");
  const q1 = await sshPsqlJson(QUEUE_SNAPSHOT_SQL, { password: pass });
  console.log(JSON.stringify({ queue_pre: q1, ...evaluateQueueSafe(q1) }));
  const ev1 = evaluateQueueSafe(q1);
  if (Number(q1.quarantined_skipped_smoke) !== QUARANTINE_SKIPPED_EXPECT) {
    fail(`quarantined_skipped_smoke=${q1.quarantined_skipped_smoke}, expected ${QUARANTINE_SKIPPED_EXPECT}`);
  }
  if (!ev1.queue_safe) fail(`queue not safe: ${ev1.errors.join("; ")}`);

  console.log("=== STEP: TCP 127.0.0.1:9000 (no HTTP) ===");
  if (!tcp9000Ok()) fail("127.0.0.1:9000 TCP not open — start TallyPrime with ODBC/HTTP on port 9000");

  if (!existsSync(AGENT_EXE)) fail(`Agent EXE missing: ${AGENT_EXE}`);
  if (!existsSync(CONFIG_PATH)) fail(`Agent config missing: ${CONFIG_PATH}`);

  const conn = await sshConnect(pass);
  const srk = await getServiceRoleKey(conn);
  console.log("=== STEP: find single-row daily date + create controlled job ===");
  const dateFrom = await findSingleDailyDate(srk, SMOKE_ORG);
  console.log(JSON.stringify({ single_daily_date: dateFrom }));

  const created = await createControlledJob(conn, srk, dateFrom);
  conn.end();

  const snap = await fetchJobBatchSnapshot(pass, created.job_id, created.batch_id);
  const job = snap.job;
  const batch = snap.batch;
  const controlled =
    job?.parameters?.e2e_controlled_single_metadata === true ||
    job?.parameters?.e2e_controlled_single_metadata === "true";

  if (job?.organization_id !== SMOKE_ORG) fail(`organization mismatch ${job?.organization_id}`);
  if (job?.report_type !== "daily_project_report") fail(`report_type=${job?.report_type}`);
  if (!controlled) fail("e2e_controlled_single_metadata not true on job");
  if (Number(job?.prepared_item_count) !== 1) fail(`prepared_item_count=${job?.prepared_item_count}`);
  if (Number(batch?.message_count) !== 1) fail(`message_count=${batch?.message_count}`);
  if (batch?.status !== "pending" && created.batch_status !== "pending") {
    fail(`batch status=${batch?.status} (expected pending before run-once)`);
  }

  console.log(
    `\n.\\connector\\tally\\dist\\PesoWise-Tally-Agent.exe run-once --job-id ${created.job_id} --batch-id ${created.batch_id}\n`,
  );

  console.log("=== STEP: Agent run-once (ONE Tally HTTP POST) ===");
  const run = spawnSync(
    AGENT_EXE,
    ["run-once", "--job-id", created.job_id, "--batch-id", created.batch_id],
    { encoding: "utf-8", timeout: 120_000 },
  );
  process.stdout.write(run.stdout || "");
  process.stderr.write(run.stderr || "");
  if (run.error) fail(run.error.message);

  const post = await fetchJobBatchSnapshot(pass, created.job_id, created.batch_id);
  const postBatch = post.batch;
  const postJob = post.job;
  const okDelivered = postBatch?.status === "delivered";
  const okManual = postBatch?.status === "manual_review";

  const q2 = await sshPsqlJson(QUEUE_SNAPSHOT_SQL, { password: pass });
  const ev2 = evaluateQueueSafe(q2);
  if (Number(q2.quarantined_skipped_smoke) !== QUARANTINE_SKIPPED_EXPECT) {
    fail(`post quarantine count=${q2.quarantined_skipped_smoke}`);
  }

  const result = {
    result: okDelivered ? "E2E PASS" : okManual ? "E2E STOPPED" : "E2E STOPPED",
    job_id: created.job_id,
    batch_id: created.batch_id,
    batch_status: postBatch?.status,
    job_status: postJob?.status,
    agent_exit: run.status,
    queue_safe_after: ev2.queue_safe,
    quarantined_skipped_smoke: q2.quarantined_skipped_smoke,
    tally_http_posts: 1,
  };
  if (!okDelivered && !okManual) result.reason = `unexpected batch status ${postBatch?.status}`;
  if (okManual) result.reason = "manual_review — inspect Tally before retry";

  console.log(JSON.stringify(result, null, 2));
  process.exit(okDelivered ? 0 : 1);
}

main().catch((e) => fail(e.message ?? String(e)));
