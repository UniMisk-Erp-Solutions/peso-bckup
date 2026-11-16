#!/usr/bin/env node
/**
 * Tally Phase 5: optional migration + deploy delivery/connector via docker cp into edge container.
 *
 * Root issue fixed: Coolify host path /data/coolify/... is root-only; `test -f` as SSH user
 * falsely reported MISSING. Runtime reads /home/deno/functions inside supabase-edge-functions-*.
 *
 * Env: DEPLOY_SSH_PASSWORD (required), SKIP_MIGRATION=1 to skip SQL
 */
import { Client } from "ssh2";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = process.env.DEPLOY_SSH_HOST ?? "192.168.23.46";
const USER = process.env.DEPLOY_SSH_USER ?? "hasto";
const PASS = process.env.DEPLOY_SSH_PASSWORD;
const SERVICE_ID = "kar0ro1k6jiyfxzzw7acnsza";
const DB = `supabase-db-${SERVICE_ID}`;
const EDGE = `supabase-edge-functions-${SERVICE_ID}`;
const DENO_ROOT = "/home/deno/functions";
const REVISION_MIGRATION = "20261007150000_tally_metadata_revision.sql";
const SKIP_MIGRATION = process.env.SKIP_MIGRATION === "1";

const REQUIRED_IN_CONTAINER = [
  "run-tally-sync-delivery/index.ts",
  "tally-connector/index.ts",
  "_shared/tallyMapping/pipeline.ts",
  "_shared/tallyMapping/accountingRegistry.ts",
  "_shared/tallyMapping/mapPreparedItem.ts",
  "_shared/tallyMapping/deliveryUpdates.ts",
  "_shared/tallyMapping/metadataRevision.ts",
  "_shared/tallyMapping/xml/serialize.ts",
  "_shared/tallySync/contentHash.ts",
  "_shared/tallyReportTypes.ts",
  "_shared/cors.ts",
];

const PRE_CHECK_SQL = `
SELECT jsonb_build_object(
  'target', 'pesowise-backup-supabase.unimisk.com',
  'last_metadata_revision_col', EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tally_delivery_state' AND column_name='last_metadata_revision'
  ),
  'delivery_updates_col', EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tally_sync_delivery_batches' AND column_name='delivery_updates'
  ),
  'expected_rev_fn', EXISTS(SELECT 1 FROM pg_proc WHERE proname='tally_expected_metadata_revision_v1'),
  'pending_tally_jobs', (SELECT count(*)::int FROM public.tally_sync_jobs WHERE status IN ('waiting_for_connector','delivering','prepared')),
  'pending_batches', (SELECT count(*)::int FROM public.tally_sync_delivery_batches WHERE status='pending')
);
`;

function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let errOut = "";
      stream.on("data", (d) => { out += d; });
      stream.stderr.on("data", (d) => { errOut += d; });
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
      await sshExec(
        conn,
        `docker exec ${EDGE} test -f ${DENO_ROOT}/${rel}`,
      );
    } catch {
      missing.push(rel);
    }
  }
  console.log(`=== Container verify (${label}) ===`, missing.length ? `MISSING: ${missing.join(", ")}` : "all required files present");
  if (missing.length) throw new Error(`Container deploy incomplete (${label}): ${missing.join(", ")}`);
}

async function dockerCp(conn, stagingPath, containerDest) {
  await sshExec(conn, `docker cp '${stagingPath}' ${EDGE}:'${containerDest}'`);
}

async function main() {
  if (!PASS) {
    console.error("Set DEPLOY_SSH_PASSWORD (Tally backup .46 only).");
    process.exit(2);
  }

  const { spawnSync } = await import("child_process");
  const v = spawnSync(process.execPath, ["scripts/tally-integration/validate-edge-import-graph.mjs"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  console.log(v.stdout || v.stderr);
  if (v.status !== 0) {
    console.error("Edge import graph validation failed — fix before deploy.");
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

  await sshExec(conn, `docker ps --format '{{.Names}}' | grep -Fx '${EDGE}' || (echo 'missing edge container' && exit 1)`);

  const mountJson = await sshExec(conn, `docker inspect ${EDGE} --format '{{json .Mounts}}'`);
  console.log("=== Edge mounts (inspect) ===");
  console.log(mountJson.trim());

  const preRaw = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "${PRE_CHECK_SQL.replace(/\n/g, " ").replace(/"/g, '\\"')}"`,
  );
  const pre = JSON.parse(preRaw.trim());
  console.log("=== PRE (read-only) ===");
  console.log(JSON.stringify(pre, null, 2));

  const needsMigration =
    !SKIP_MIGRATION &&
    (!pre.last_metadata_revision_col || !pre.delivery_updates_col || !pre.expected_rev_fn);

  if (SKIP_MIGRATION) console.log("=== SKIP_MIGRATION=1 — SQL not applied ===");

  if (needsMigration) {
    console.log("=== APPLY migration ===", REVISION_MIGRATION);
    const sql = readFileSync(join(ROOT, "supabase/migrations", REVISION_MIGRATION), "utf-8");
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    const remote = `/tmp/${REVISION_MIGRATION}`;
    await new Promise((res, rej) => sftp.writeFile(remote, sql, (e) => (e ? rej(e) : res())));
    await sshExec(
      conn,
      `cat ${remote} | docker exec -i ${DB} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - && rm -f ${remote}`,
    );
    console.log("Applied:", REVISION_MIGRATION);
  } else {
    console.log("=== SKIP migration (already present) ===");
  }

  const staging = `/home/${USER}/peso-tally-edge-staging`;
  console.log("=== SFTP staging ===", staging);
  await sshExec(conn, `rm -rf '${staging}' && mkdir -p '${staging}/_shared'`);
  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
  const uploads = [
    [join(ROOT, "supabase/functions/run-tally-sync-delivery"), `${staging}/run-tally-sync-delivery`],
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

  console.log("=== docker cp into edge container ===", EDGE);
  await sshExec(conn, `docker exec ${EDGE} mkdir -p ${DENO_ROOT}/_shared`);
  await sshExec(
    conn,
    `docker exec ${EDGE} sh -c 'rm -rf ${DENO_ROOT}/_shared/tallyMapping ${DENO_ROOT}/_shared/tallySync ${DENO_ROOT}/run-tally-sync-delivery ${DENO_ROOT}/tally-connector'`,
  );

  await dockerCp(conn, `${staging}/run-tally-sync-delivery`, `${DENO_ROOT}/run-tally-sync-delivery`);
  await dockerCp(conn, `${staging}/tally-connector`, `${DENO_ROOT}/tally-connector`);
  await dockerCp(conn, `${staging}/_shared/tallyMapping`, `${DENO_ROOT}/_shared/tallyMapping`);
  await dockerCp(conn, `${staging}/_shared/tallySync`, `${DENO_ROOT}/_shared/tallySync`);
  await dockerCp(conn, `${staging}/_shared/tallyReportTypes.ts`, `${DENO_ROOT}/_shared/tallyReportTypes.ts`);
  await dockerCp(conn, `${staging}/_shared/cors.ts`, `${DENO_ROOT}/_shared/cors.ts`);

  await verifyInContainer(conn, "before restart");
  await sshExec(conn, `rm -rf '${staging}'`);

  console.log("=== Restart edge ===", EDGE);
  await sshExec(conn, `docker restart ${EDGE}`);
  await sshExec(conn, `sleep 3`);
  await sshExec(conn, `docker ps --filter name=${EDGE} --format '{{.Status}}' | head -1`);

  await verifyInContainer(conn, "after restart");

  const postRaw = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "${PRE_CHECK_SQL.replace(/\n/g, " ").replace(/"/g, '\\"')}"`,
  );
  console.log("=== POST DB ===");
  console.log(JSON.stringify(JSON.parse(postRaw.trim()), null, 2));

  conn.end();
  console.log("DONE — edge functions deployed to container");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
