#!/usr/bin/env node
/**
 * Deploy Tally migrations + edge functions to PesoWise backup Supabase ONLY (.46).
 * Requires: DEPLOY_SSH_PASSWORD (never commit)
 */
import { Client } from "ssh2";
import { readFileSync, readdirSync, statSync, createReadStream } from "fs";
import { join, relative, sep } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "../..");

const HOST = process.env.DEPLOY_SSH_HOST ?? "192.168.23.46";
const USER = process.env.DEPLOY_SSH_USER ?? "ssh";
const PASS = process.env.DEPLOY_SSH_PASSWORD;
const SERVICE_ID = "kar0ro1k6jiyfxzzw7acnsza";
const DB_CONTAINER = `supabase-db-${SERVICE_ID}`;
const FUNCS_VOL = `/data/coolify/services/${SERVICE_ID}/volumes/functions`;

const MIGRATIONS = [
  "20261005160000_tally_sync_jobs_phase2.sql",
  "20261005170000_tally_sync_preparation_phase3.sql",
  "20261005180000_tally_sync_background_phase36.sql",
  "20261005190000_report_expense_rows_status_text_cast.sql",
  "20261006120000_tally_delivery_state_phase4.sql",
  "20261007120000_tally_connector_phase5.sql",
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
    if (statSync(lp).isDirectory()) {
      await uploadDir(sftp, lp, rp);
    } else {
      await new Promise((resolve, reject) => {
        sftp.fastPut(lp, rp, (err) => (err ? reject(err) : resolve()));
      });
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

  console.log("=== Verify PesoWise stack only ===");
  const ps = await sshExec(
    conn,
    `docker ps --format '{{.Names}}' | grep '${SERVICE_ID}' | grep -v grep || true`,
  );
  const names = ps.trim().split("\n").filter(Boolean);
  if (!names.some((n) => n.includes("supabase-db"))) {
    throw new Error(`DB container not found for ${SERVICE_ID}`);
  }
  console.log(names.join("\n"));

  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });

  console.log("=== Apply migrations ===");
  await sshExec(conn, "mkdir -p /tmp/peso-tally-migrate");
  for (const file of MIGRATIONS) {
    const localPath = join(ROOT, "supabase/migrations", file);
    const remotePath = `/tmp/peso-tally-migrate/${file}`;
    await new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()));
    });
    await sshExec(
      conn,
      `cat ${remotePath} | docker exec -i ${DB_CONTAINER} psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - && rm -f ${remotePath}`,
    );
    console.log("Applied:", file);
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
    await uploadDir(sftp, local, remote);
    console.log("Staged:", relative(ROOT, local));
  }
  const sudop = PASS.replace(/'/g, `'\\''`);
  await sshExec(
    conn,
    `echo '${sudop}' | sudo -S mkdir -p ${FUNCS_VOL}/_shared && echo '${sudop}' | sudo -S cp -r ${staging}/run-tally-sync-job ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/run-tally-sync-delivery ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/start-tally-sync ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/tally-connector ${FUNCS_VOL}/ && echo '${sudop}' | sudo -S cp -r ${staging}/_shared/tallySync ${FUNCS_VOL}/_shared/ && echo '${sudop}' | sudo -S cp -r ${staging}/_shared/tallyMapping ${FUNCS_VOL}/_shared/ && echo '${sudop}' | sudo -S cp ${staging}/_shared/tallyReportTypes.ts ${FUNCS_VOL}/_shared/ && rm -rf ${staging}`,
  );
  console.log("Copied to edge functions volume with sudo");

  const edgeContainer = names.find((n) => n.includes("edge-runtime")) ?? names.find((n) => n.includes("edge"));
  if (edgeContainer) {
    console.log("=== Restart edge runtime:", edgeContainer, "===");
    await sshExec(conn, `docker restart ${edgeContainer}`);
  } else {
    console.warn("Edge runtime container not found by name — skip restart (verify manually)");
  }

  console.log("=== DB verify ===");
  const verify = await sshExec(
    conn,
    `docker exec ${DB_CONTAINER} psql -U supabase_admin -d postgres -tAc "SELECT to_regclass('public.tally_sync_jobs'), to_regclass('public.tally_sync_job_items');"`,
  );
  console.log("tables:", verify.trim());

  const rpc = await sshExec(
    conn,
    `docker exec ${DB_CONTAINER} psql -U supabase_admin -d postgres -tAc "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE '%tally_sync%';"`,
  );
  console.log("tally_sync rpc count:", rpc.trim());

  conn.end();
  console.log("DONE");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
