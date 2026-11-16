#!/usr/bin/env node
/** Hot-deploy _shared/tallyMapping to edge container (voucher ledger name fix). */
import { Client } from "ssh2";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import {
  resolveCoolifySshHost,
  resolveCoolifySshUser,
  requireCoolifySshPassword,
} from "./_coolifySshCredentials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = resolveCoolifySshHost();
const USER = resolveCoolifySshUser();
const EDGE = "supabase-edge-functions-kar0ro1k6jiyfxzzw7acnsza";
const DENO_ROOT = "/home/deno/functions";

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

async function main() {
  const pass = requireCoolifySshPassword();
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on("ready", resolve).on("error", reject).connect({
      host: HOST,
      username: USER,
      password: pass,
      readyTimeout: 25000,
    });
  });

  const staging = `/home/${USER}/peso-tally-mapping-staging`;
  const localMap = join(ROOT, "supabase/functions/_shared/tallyMapping");
  await sshExec(conn, `rm -rf '${staging}' && mkdir -p '${staging}'`);
  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
  await uploadDir(sftp, localMap, `${staging}/tallyMapping`);
  console.log("Staged:", relative(ROOT, localMap));
  await sshExec(conn, `docker exec ${EDGE} rm -rf ${DENO_ROOT}/_shared/tallyMapping`);
  await sshExec(conn, `docker cp '${staging}/tallyMapping' ${EDGE}:'${DENO_ROOT}/_shared/tallyMapping'`);
  await sshExec(conn, `rm -rf '${staging}'`);
  await sshExec(conn, `docker restart ${EDGE}`);
  console.log("DEPLOY_TALLY_MAPPING_OK");
  conn.end();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
