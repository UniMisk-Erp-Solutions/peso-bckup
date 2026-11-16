#!/usr/bin/env node
/**
 * Apply Phase 4+5 migrations ONLY if missing + sync Tally edge functions.
 * PesoWise stack kar0ro1k6jiyfxzzw7acnsza on .46 only.
 */
import { Client } from "ssh2";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "../..");
const HOST = process.env.DEPLOY_SSH_HOST ?? "192.168.23.46";
const USER = process.env.DEPLOY_SSH_USER ?? "hasto";
const PASS = process.env.DEPLOY_SSH_PASSWORD;
const SERVICE_ID = "kar0ro1k6jiyfxzzw7acnsza";
const DB = `supabase-db-${SERVICE_ID}`;
const FUNCS_VOL = `/data/coolify/services/${SERVICE_ID}/volumes/functions`;

const PHASE45 = [
  "20261006120000_tally_delivery_state_phase4.sql",
  "20261007120000_tally_connector_phase5.sql",
  "20261007140000_tally_quarantine_smoke_batches.sql",
];

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
    else {
      await new Promise((res, rej) => sftp.fastPut(lp, rp, (e) => (e ? rej(e) : res())));
    }
  }
}

async function main() {
  if (!PASS) {
    console.error("DEPLOY_SSH_PASSWORD required");
    process.exit(2);
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

  const ps = await sshExec(
    conn,
    `docker ps --format '{{.Names}}' | grep '${SERVICE_ID}' | grep -v grep || true`,
  );
  const names = ps.trim().split("\n").filter(Boolean);
  if (!names.some((n) => n.includes("supabase-db"))) {
    throw new Error(`DB container not found for ${SERVICE_ID}`);
  }
  console.log("=== Stack containers ===");
  console.log(names.join("\n"));

  const pre = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "SELECT jsonb_build_object('tally_delivery_state', to_regclass('public.tally_delivery_state') IS NOT NULL, 'tally_sync_delivery_batches', to_regclass('public.tally_sync_delivery_batches') IS NOT NULL);"`,
  );
  console.log("=== DB before ===", pre.trim());

  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });

  const needPhase4 = !pre.includes("true") || pre.includes("false");
  const parsed = JSON.parse(pre.trim() || "{}");
  const toApply = [];
  if (!parsed.tally_delivery_state) toApply.push(PHASE45[0]);
  if (!parsed.tally_sync_delivery_batches) toApply.push(PHASE45[1]);
  if (toApply.length === 0) console.log("=== Phase 4+5 migrations already present — skip SQL ===");
  else {
    console.log("=== Apply migrations ===", toApply.join(", "));
    await sshExec(conn, "mkdir -p /tmp/peso-tally-migrate");
    for (const file of toApply) {
      const localPath = join(ROOT, "supabase/migrations", file);
      const remotePath = `/tmp/peso-tally-migrate/${file}`;
      await new Promise((res, rej) => sftp.fastPut(localPath, remotePath, (e) => (e ? rej(e) : res())));
      await sshExec(
        conn,
        `cat ${remotePath} | docker exec -i ${DB} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - && rm -f ${remotePath}`,
      );
      console.log("Applied:", file);
    }
  }

  console.log("=== Sync edge functions ===");
  const staging = `/home/${USER}/peso-tally-functions-staging`;
  await sshExec(conn, `rm -rf ${staging} && mkdir -p ${staging}/_shared`);
  const uploads = [
    [join(ROOT, "supabase/functions/run-tally-sync-job"), `${staging}/run-tally-sync-job`],
    [join(ROOT, "supabase/functions/run-tally-sync-delivery"), `${staging}/run-tally-sync-delivery`],
    [join(ROOT, "supabase/functions/start-tally-sync"), `${staging}/start-tally-sync`],
    [join(ROOT, "supabase/functions/tally-connector"), `${staging}/tally-connector`],
    [join(ROOT, "supabase/functions/_shared/tallySync"), `${staging}/_shared/tallySync`],
    [join(ROOT, "supabase/functions/_shared/tallyMapping"), `${staging}/_shared/tallyMapping`],
    [join(ROOT, "supabase/functions/_shared/tallyReportTypes.ts"), `${staging}/_shared/tallyReportTypes.ts`],
  ];
  for (const [local, remote] of uploads) {
    if (statSync(local).isDirectory()) {
      await uploadDir(sftp, local, remote);
    } else {
      await sftpMkdirP(sftp, remote.substring(0, remote.lastIndexOf("/")));
      await new Promise((res, rej) => sftp.fastPut(local, remote, (e) => (e ? rej(e) : res())));
    }
    console.log("Staged:", relative(ROOT, local));
  }
  const sudop = PASS.replace(/'/g, `'\\''`);
  await sshExec(
    conn,
    `echo '${sudop}' | sudo -S mkdir -p ${FUNCS_VOL}/_shared && echo '${sudop}' | sudo -S cp -r ${staging}/run-tally-sync-job ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/run-tally-sync-delivery ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/start-tally-sync ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/tally-connector ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/_shared/tallySync ${FUNCS_VOL}/_shared/ && echo '${sudop}' | sudo -S cp -r ${staging}/_shared/tallyMapping ${FUNCS_VOL}/_shared/ && echo '${sudop}' | sudo -S cp ${staging}/_shared/tallyReportTypes.ts ${FUNCS_VOL}/_shared/ && rm -rf ${staging}`,
  );

  const edgeContainer = names.find((n) => n.includes("edge-runtime")) ?? names.find((n) => n.includes("edge"));
  if (edgeContainer) {
    console.log("=== Restart edge:", edgeContainer, "===");
    await sshExec(conn, `docker restart ${edgeContainer}`);
  }

  const post = await sshExec(
    conn,
    `docker exec ${DB} psql -U supabase_admin -d postgres -tAc "SELECT jsonb_build_object('tables', jsonb_build_array(to_regclass('public.tally_delivery_state')::text, to_regclass('public.tally_sync_delivery_batches')::text, to_regclass('public.tally_connector_devices')::text), 'rpc_claim', EXISTS(SELECT 1 FROM pg_proc WHERE proname='connector_claim_delivery_batch_v1'), 'rpc_store', EXISTS(SELECT 1 FROM pg_proc WHERE proname='store_tally_delivery_batches_v1'));"`,
  );
  console.log("=== DB after ===", post.trim());
  conn.end();
  console.log("DONE");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
