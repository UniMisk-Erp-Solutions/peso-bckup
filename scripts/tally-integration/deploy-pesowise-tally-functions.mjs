#!/usr/bin/env node
/** Deploy only PesoWise's Tally edge functions to its explicitly pinned Coolify service. */
import { Client } from "ssh2";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  COOLIFY_BACKUP_SERVICE_ID,
  resolveCoolifySshHost,
  resolveCoolifySshPassword,
  resolveCoolifySshUser,
} from "./_coolifySshCredentials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE = COOLIFY_BACKUP_SERVICE_ID;
const DB = `supabase-db-${SERVICE}`;
const EDGE = `supabase-edge-functions-${SERVICE}`;
const DENO_ROOT = "/home/deno/functions";
const FUNCTION_DIRS = [
  "start-tally-sync",
  "run-tally-sync-job",
  "run-tally-sync-delivery",
  "tally-connector",
];
const SHARED_FILES = [
  "_shared/cors.ts",
  "_shared/tallyReportTypes.ts",
];
const SHARED_DIRS = ["_shared/tallySync", "_shared/tallyMapping"];

function remoteExec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => (stdout += chunk));
      stream.stderr.on("data", (chunk) => (stderr += chunk));
      stream.on("close", (code) =>
        code === 0 ? resolve(stdout.trim()) : reject(new Error(`remote command failed (${code}): ${stderr.trim() || stdout.trim()}`)),
      );
    });
  });
}

function sftpMkdir(sftp, path) {
  return new Promise((resolve, reject) => sftp.mkdir(path, (error) => (error ? reject(error) : resolve())));
}

async function mkdirP(sftp, path) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    await new Promise((resolve, reject) =>
      sftp.mkdir(current, (error) => (!error || error.code === 4 ? resolve() : reject(error))),
    );
  }
}

async function uploadTree(sftp, local, remote) {
  await mkdirP(sftp, remote);
  for (const name of readdirSync(local)) {
    const src = join(local, name);
    const dst = `${remote}/${name}`;
    if (statSync(src).isDirectory()) await uploadTree(sftp, src, dst);
    else await new Promise((resolve, reject) => sftp.fastPut(src, dst, (error) => (error ? reject(error) : resolve())));
  }
}

function walkFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walkFiles(path, base) : [relative(base, path).replace(/\\/g, "/")];
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function main() {
  const password = resolveCoolifySshPassword();
  if (!password) throw new Error("PesoWise Coolify SSH credential is unavailable; no deployment attempted");

  const validation = spawnSync(process.execPath, ["scripts/tally-integration/validate-edge-import-graph.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (validation.status !== 0) throw new Error(validation.stdout || validation.stderr || "Edge import graph validation failed");

  for (const dir of [...FUNCTION_DIRS, ...SHARED_DIRS]) {
    if (!existsSync(join(ROOT, "supabase/functions", dir))) throw new Error(`Required source folder missing: ${dir}`);
  }
  for (const path of SHARED_FILES) {
    if (!existsSync(join(ROOT, "supabase/functions", path))) throw new Error(`Required shared file missing: ${path}`);
  }

  const conn = new Client();
  await new Promise((resolve, reject) =>
    conn
      .on("ready", resolve)
      .on("error", reject)
      .connect({
        host: resolveCoolifySshHost(),
        port: 22,
        username: resolveCoolifySshUser(),
        password,
        readyTimeout: 30_000,
      }),
  );

  const stage = `/tmp/pw-tally-deploy-${randomUUID()}`;
  const safeStage = /^\/tmp\/pw-tally-deploy-[0-9a-f-]{36}$/.test(stage);
  if (!safeStage) throw new Error("Unsafe temporary deployment path");

  try {
    const names = (await remoteExec(conn, `docker ps --filter 'name=${SERVICE}' --format '{{.Names}}'`))
      .split(/\r?\n/)
      .filter(Boolean);
    if (!names.includes(DB) || !names.includes(EDGE)) {
      throw new Error(`Pinned PesoWise service is incomplete; expected ${DB} and ${EDGE}`);
    }
    const identity = await remoteExec(
      conn,
      `docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' ${DB} && ` +
        `docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.service" }}' ${EDGE}`,
    );
    const identityLines = identity.split(/\r?\n/);
    if (identityLines.some((line) => line.split("|")[0] !== SERVICE)) {
      throw new Error("Pinned container labels do not match the PesoWise Coolify service; stopped before mutation");
    }

    const sql = `WITH f AS (
      SELECT oid, proname, pg_get_functiondef(oid) d FROM pg_proc
      WHERE proname IN ('connector_claim_delivery_batch_v1','connector_ack_delivery_batch_v1','reconcile_tally_delivery_batch_v1')
    ) SELECT json_build_object(
      'tables', to_regclass('public.tally_sync_delivery_batches') IS NOT NULL
        AND to_regclass('public.tally_delivery_reconciliation_events') IS NOT NULL,
      'manual_review_constraint', EXISTS(SELECT 1 FROM pg_constraint WHERE conname='tally_sync_delivery_batches_status_check' AND pg_get_constraintdef(oid) LIKE '%manual_review%'),
      'claim_signature', (SELECT count(*)=1 FROM pg_proc WHERE proname='connector_claim_delivery_batch_v1' AND pg_get_function_arguments(oid) LIKE '%p_expected_company_name%'),
      'claim_org_company_lease_safe', (SELECT d LIKE '%organization_id = v_org%' AND d LIKE '%connector_version = ''0.6.0-company-verify''%' AND d LIKE '%lease_expires_at <= now()%' AND d LIKE '%SET status = ''manual_review''%' FROM f WHERE proname='connector_claim_delivery_batch_v1'),
      'ack_single_and_safe', (SELECT count(*)=1 FROM f WHERE proname='connector_ack_delivery_batch_v1') AND (SELECT d LIKE '%lease_expires_at <= now()%' AND d LIKE '%p_success IS DISTINCT FROM TRUE%' AND d LIKE '%status = ''manual_review''%' AND d LIKE '%metadata_revision%' FROM f WHERE proname='connector_ack_delivery_batch_v1'),
      'audited_reconcile', (SELECT d LIKE '%tally_delivery_reconciliation_events%' AND d LIKE '%auth.uid()%' AND d LIKE '%p_evidence%' FROM f WHERE proname='reconcile_tally_delivery_batch_v1'),
      'reconcile_authenticated_only', (SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('service_role', oid, 'EXECUTE') FROM f WHERE proname='reconcile_tally_delivery_batch_v1'),
      'audit_rls', (SELECT relrowsecurity FROM pg_class WHERE oid='public.tally_delivery_reconciliation_events'::regclass),
      'org_scoped_audit_select', EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tally_delivery_reconciliation_events' AND cmd='SELECT' AND qual LIKE '%tally_sync_admin_can_view_v1%'),
      'no_direct_audit_write_policy', NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tally_delivery_reconciliation_events' AND cmd IN ('INSERT','UPDATE','DELETE','ALL'))
    )::text;`;
    const dbCheck = await remoteExec(
      conn,
      `docker exec ${DB} psql -U supabase_admin -d postgres -Atc ${quote(sql)}`,
    );
    const check = JSON.parse(dbCheck);
    if (Object.values(check).some((value) => value !== true)) {
      throw new Error(`Existing PesoWise delivery safety schema did not pass preflight: ${JSON.stringify(check)}`);
    }
    console.log("PesoWise database safety preflight: PASS (schema already applied; migration history is not authoritative on this manually-managed stack)");

    const sftp = await new Promise((resolve, reject) => conn.sftp((error, client) => (error ? reject(error) : resolve(client))));
    await mkdirP(sftp, stage);
    for (const dir of [...FUNCTION_DIRS, ...SHARED_DIRS]) {
      const local = join(ROOT, "supabase/functions", dir);
      await uploadTree(sftp, local, `${stage}/${dir}`);
    }
    for (const file of SHARED_FILES) {
      const local = join(ROOT, "supabase/functions", file);
      const remote = `${stage}/${file}`;
      await mkdirP(sftp, remote.slice(0, remote.lastIndexOf("/")));
      await new Promise((resolve, reject) => sftp.fastPut(local, remote, (error) => (error ? reject(error) : resolve())));
    }

    await remoteExec(conn, `docker cp ${quote(`${stage}/.`)} ${EDGE}:/tmp/pw-tally-source`);
    const dirs = [...FUNCTION_DIRS, ...SHARED_DIRS];
    const copies = dirs.map((dir) =>
      `mkdir -p ${quote(`${DENO_ROOT}/${dir}`)} && cp -a ${quote(`/tmp/pw-tally-source/${dir}/.`)} ${quote(`${DENO_ROOT}/${dir}/`)}`,
    );
    const files = SHARED_FILES.map((file) =>
      `mkdir -p ${quote(`${DENO_ROOT}/${file.slice(0, file.lastIndexOf("/"))}`)} && cp ${quote(`/tmp/pw-tally-source/${file}`)} ${quote(`${DENO_ROOT}/${file}`)}`,
    );
    await remoteExec(conn, `docker exec ${EDGE} sh -lc ${quote(`set -eu; ${[...copies, ...files].join("; ")}`)}`);

    const checksums = [];
    for (const dir of [...FUNCTION_DIRS, ...SHARED_DIRS]) {
      const source = join(ROOT, "supabase/functions", dir);
      for (const file of walkFiles(source)) checksums.push([`${dir}/${file}`, sha256(join(source, file))]);
    }
    for (const file of SHARED_FILES) checksums.push([file, sha256(join(ROOT, "supabase/functions", file))]);
    for (const [file, expected] of checksums) {
      const actual = await remoteExec(
        conn,
        `docker exec ${EDGE} sha256sum ${quote(`${DENO_ROOT}/${file}`)}`,
      );
      if (actual.split(/\s+/)[0] !== expected) throw new Error(`Checksum mismatch in PesoWise edge container: ${file}`);
    }
    console.log(`Uploaded and checksum-verified ${checksums.length} files in the pinned PesoWise edge runtime.`);

    await remoteExec(conn, `docker restart ${EDGE}`);
    let running = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      running = (await remoteExec(conn, `docker inspect --format '{{.State.Running}}' ${EDGE}`)) === "true";
      if (running) break;
    }
    if (!running) throw new Error("PesoWise edge runtime did not return to running state after restart");
    for (const [file, expected] of checksums) {
      const actual = await remoteExec(conn, `docker exec ${EDGE} sha256sum ${quote(`${DENO_ROOT}/${file}`)}`);
      if (actual.split(/\s+/)[0] !== expected) throw new Error(`Post-restart checksum mismatch: ${file}`);
    }
    console.log(`PesoWise edge runtime restarted and verified; ${FUNCTION_DIRS.length} functions deployed.`);

    await remoteExec(conn, `docker exec ${EDGE} sh -lc ${quote(`rm -rf /tmp/pw-tally-source`)}`);
    console.log("DEPLOY_PESOWISE_TALLY_FUNCTIONS_OK");
  } finally {
    if (safeStage) {
      try {
        await remoteExec(conn, `test ${quote(stage)} = ${quote(stage)} && rm -rf ${quote(stage)}`);
      } catch {
        console.warn("Temporary SFTP staging cleanup could not be confirmed.");
      }
    }
    conn.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? String(error));
  process.exit(1);
});
