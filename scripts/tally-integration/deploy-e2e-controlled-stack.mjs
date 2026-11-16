#!/usr/bin/env node
/**
 * Apply ONLY 20261007170000_tally_e2e_controlled_delivery.sql (if needed) +
 * deploy run-tally-sync-delivery + tally-connector (+ shared mapping) via staging → docker cp.
 *
 * Env: DEPLOY_SSH_PASSWORD (required), DEPLOY_SSH_PASSWORD_FILE (optional)
 */
import { Client } from "ssh2";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  resolveCoolifySshHost,
  resolveCoolifySshUser,
  resolveCoolifySshPassword,
} from "./_coolifySshCredentials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = resolveCoolifySshHost();
const USER = resolveCoolifySshUser();
const SERVICE_ID = "kar0ro1k6jiyfxzzw7acnsza";
const DB = `supabase-db-${SERVICE_ID}`;
const EDGE = `supabase-edge-functions-${SERVICE_ID}`;
const DENO_ROOT = "/home/deno/functions";
const E2E_MIGRATION = "20261007170000_tally_e2e_controlled_delivery.sql";
const CHUNK_MIGRATION = "20261007183000_tally_delivery_chunk.sql";
const CLAIM_LEASE_MIGRATION = "20261007210000_tally_claim_lease_reclaim.sql";

const REQUIRED_IN_CONTAINER = [
  "run-tally-sync-delivery/index.ts",
  "run-tally-sync-job/index.ts",
  "_shared/tallySync/enqueueDeliveryBatches.ts",
  "tally-connector/index.ts",
  "_shared/tallyMapping/controlledE2e.ts",
  "_shared/tallyMapping/pipeline.ts",
  "_shared/tallyMapping/mapPreparedItem.ts",
  "_shared/cors.ts",
];

const PRE_CHECK_SQL = `
SELECT jsonb_build_object(
  'e2e_claim_job_param', EXISTS(
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'connector_claim_delivery_batch_v1'
      AND pg_get_function_arguments(p.oid) LIKE '%p_job_id%'
  ),
  'e2e_ack_hold', EXISTS(
    SELECT 1 FROM pg_proc p
    WHERE p.proname = 'connector_ack_delivery_batch_v1'
      AND pg_get_function_arguments(p.oid) LIKE '%p_e2e_hold%'
  ),
  'manual_review_in_check', EXISTS(
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'tally_sync_delivery_batches'
      AND c.conname = 'tally_sync_delivery_batches_status_check'
      AND pg_get_constraintdef(c.oid) LIKE '%manual_review%'
  )
);
`;

function resolvePassword() {
  const fromCoolify = resolveCoolifySshPassword();
  if (fromCoolify) return fromCoolify;
  const file = process.env.DEPLOY_SSH_PASSWORD_FILE;
  if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
  return null;
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
        if (code !== 0) reject(new Error(`exit ${code}: ${errOut || out}`));
        else resolve(out);
      });
    });
  });
}

function sftpMkdirP(sftp, dir) {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dir, (err) => {
      if (!err || err.code === 4) return resolve();
      reject(err);
    });
  });
}

async function uploadDir(sftp, localDir, remoteDir) {
  await sftpMkdirP(sftp, remoteDir);
  for (const name of readdirSync(localDir)) {
    const lp = join(localDir, name);
    const rp = `${remoteDir}/${name}`;
    if (statSync(lp).isDirectory()) await uploadDir(sftp, lp, rp);
    else await new Promise((res, rej) => sftp.fastPut(lp, rp, (e) => (e ? rej(e) : res())));
  }
}

async function verifyInContainer(conn, label) {
  const missing = [];
  for (const rel of REQUIRED_IN_CONTAINER) {
    try {
      await sshExec(conn, `docker exec ${EDGE} test -f ${DENO_ROOT}/${rel}`);
    } catch {
      missing.push(rel);
    }
  }
  console.log(`=== Container verify (${label}) ===`, missing.length ? `MISSING: ${missing.join(", ")}` : "ok");
  if (missing.length) throw new Error(`Container deploy incomplete: ${missing.join(", ")}`);
}

async function main() {
  const PASS = resolvePassword();
  if (!PASS) {
    console.error("Set COOLIFY_SSH_PASSWORD or .local-sensitive-data/coolify_ssh_password.txt");
    process.exit(2);
  }

  const v = spawnSync(process.execPath, ["scripts/tally-integration/validate-edge-import-graph.mjs"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (v.status !== 0) {
    console.error(v.stdout || v.stderr);
    process.exit(1);
  }

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on("ready", resolve).on("error", reject).connect({
      host: HOST,
      port: 22,
      username: USER,
      password: PASS,
      readyTimeout: 30000,
    });
  });

  await sshExec(conn, `docker ps --format '{{.Names}}' | grep -Fx '${EDGE}'`);

  const preRaw = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "${PRE_CHECK_SQL.replace(/\n/g, " ").replace(/"/g, '\\"')}"`,
  );
  const pre = JSON.parse(preRaw.trim());
  console.log("=== PRE e2e stack ===", JSON.stringify(pre));

  const needsMigration = !pre.e2e_claim_job_param || !pre.e2e_ack_hold || !pre.manual_review_in_check;
  if (needsMigration) {
    console.log("=== APPLY migration ===", E2E_MIGRATION);
    const sql = readFileSync(join(ROOT, "supabase/migrations", E2E_MIGRATION), "utf-8");
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    const remote = `/tmp/${E2E_MIGRATION}`;
    await new Promise((res, rej) => sftp.writeFile(remote, sql, (e) => (e ? rej(e) : res())));
    await sshExec(
      conn,
      `cat ${remote} | docker exec -i ${DB} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - && rm -f ${remote}`,
    );
  } else {
    console.log("=== SKIP migration (e2e already present) ===");
  }

  const chunkCheckRaw = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='load_tally_sync_job_items_page_v1');"`,
  );
  if (chunkCheckRaw.trim() !== "t") {
    console.log("=== APPLY migration ===", CHUNK_MIGRATION);
    const chunkSql = readFileSync(join(ROOT, "supabase/migrations", CHUNK_MIGRATION), "utf-8");
    const sftp2 = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    const remoteChunk = `/tmp/${CHUNK_MIGRATION}`;
    await new Promise((res, rej) => sftp2.writeFile(remoteChunk, chunkSql, (e) => (e ? rej(e) : res())));
    await sshExec(
      conn,
      `cat ${remoteChunk} | docker exec -i ${DB} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - && rm -f ${remoteChunk}`,
    );
  } else {
    console.log("=== SKIP chunk migration (already present) ===");
  }

  const claimFixRaw = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "SELECT pg_get_functiondef(p.oid) LIKE '%lease_expires_at < now()%' AND pg_get_functiondef(p.oid) NOT LIKE '%b.id <> p_batch_id%' FROM pg_proc p WHERE p.proname='connector_claim_delivery_batch_v1' LIMIT 1;"`,
  );
  if (claimFixRaw.trim() !== "t") {
    console.log("=== APPLY migration ===", CLAIM_LEASE_MIGRATION);
    const claimSql = readFileSync(join(ROOT, "supabase/migrations", CLAIM_LEASE_MIGRATION), "utf-8");
    const sftpClaim = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    const remoteClaim = `/tmp/${CLAIM_LEASE_MIGRATION}`;
    await new Promise((res, rej) => sftpClaim.writeFile(remoteClaim, claimSql, (e) => (e ? rej(e) : res())));
    await sshExec(
      conn,
      `cat ${remoteClaim} | docker exec -i ${DB} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - && rm -f ${remoteClaim}`,
    );
  } else {
    console.log("=== SKIP claim lease migration (already fixed) ===");
  }

  const staging = `/home/${USER}/peso-tally-edge-staging-e2e`;
  await sshExec(conn, `rm -rf '${staging}' && mkdir -p '${staging}/_shared'`);
  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
  const uploads = [
    [join(ROOT, "supabase/functions/run-tally-sync-delivery"), `${staging}/run-tally-sync-delivery`],
    [join(ROOT, "supabase/functions/run-tally-sync-job"), `${staging}/run-tally-sync-job`],
    [join(ROOT, "supabase/functions/tally-connector"), `${staging}/tally-connector`],
    [join(ROOT, "supabase/functions/_shared/tallyMapping"), `${staging}/_shared/tallyMapping`],
    [join(ROOT, "supabase/functions/_shared/tallySync"), `${staging}/_shared/tallySync`],
    [join(ROOT, "supabase/functions/_shared/tallyReportTypes.ts"), `${staging}/_shared/tallyReportTypes.ts`],
    [join(ROOT, "supabase/functions/_shared/cors.ts"), `${staging}/_shared/cors.ts`],
  ];
  for (const [local, remote] of uploads) {
    if (statSync(local).isDirectory()) await uploadDir(sftp, local, remote);
    else {
      await sftpMkdirP(sftp, remote.substring(0, remote.lastIndexOf("/")));
      await new Promise((res, rej) => sftp.fastPut(local, remote, (e) => (e ? rej(e) : res())));
    }
    console.log("Staged:", relative(ROOT, local));
  }

  await sshExec(conn, `docker exec ${EDGE} mkdir -p ${DENO_ROOT}/_shared`);
  await sshExec(
    conn,
    `docker exec ${EDGE} sh -c 'rm -rf ${DENO_ROOT}/_shared/tallyMapping ${DENO_ROOT}/_shared/tallySync ${DENO_ROOT}/run-tally-sync-delivery ${DENO_ROOT}/run-tally-sync-job ${DENO_ROOT}/tally-connector'`,
  );
  for (const [src, dest] of [
    [`${staging}/run-tally-sync-delivery`, `${DENO_ROOT}/run-tally-sync-delivery`],
    [`${staging}/run-tally-sync-job`, `${DENO_ROOT}/run-tally-sync-job`],
    [`${staging}/tally-connector`, `${DENO_ROOT}/tally-connector`],
    [`${staging}/_shared/tallyMapping`, `${DENO_ROOT}/_shared/tallyMapping`],
    [`${staging}/_shared/tallySync`, `${DENO_ROOT}/_shared/tallySync`],
    [`${staging}/_shared/tallyReportTypes.ts`, `${DENO_ROOT}/_shared/tallyReportTypes.ts`],
    [`${staging}/_shared/cors.ts`, `${DENO_ROOT}/_shared/cors.ts`],
  ]) {
    await sshExec(conn, `docker cp '${src}' ${EDGE}:'${dest}'`);
  }
  await verifyInContainer(conn, "before restart");
  await sshExec(conn, `rm -rf '${staging}'`);
  await sshExec(conn, `docker restart ${EDGE}`);
  await sshExec(conn, "sleep 4");
  await verifyInContainer(conn, "after restart");

  const postRaw = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "${PRE_CHECK_SQL.replace(/\n/g, " ").replace(/"/g, '\\"')}"`,
  );
  console.log("=== POST e2e stack ===", postRaw.trim());
  conn.end();
  console.log("DEPLOY_E2E_CONTROLLED_OK");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
