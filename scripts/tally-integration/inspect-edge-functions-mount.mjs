#!/usr/bin/env node
/** READ ONLY — edge container mounts + /home/deno/functions listing. */
import { Client } from "ssh2";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const host = process.env.DEPLOY_SSH_HOST ?? "192.168.23.46";
const SERVICE_ID = "kar0ro1k6jiyfxzzw7acnsza";
const EDGE = `supabase-edge-functions-${SERVICE_ID}`;
const DENO_ROOT = "/home/deno/functions";

if (!pass) {
  console.error("Set DEPLOY_SSH_PASSWORD");
  process.exit(2);
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let errOut = "";
      stream.on("data", (d) => { out += d; });
      stream.stderr.on("data", (d) => { errOut += d; });
      stream.on("close", (code) => resolve({ code, out, errOut }));
    });
  });
}

const conn = new Client();
conn.on("ready", async () => {
  const mounts = await exec(conn, `docker inspect ${EDGE} --format '{{json .Mounts}}'`);
  const lsRoot = await exec(conn, `docker exec ${EDGE} ls -la ${DENO_ROOT} 2>&1 | head -40`);
  const lsShared = await exec(conn, `docker exec ${EDGE} ls -laR ${DENO_ROOT}/_shared/tallyMapping 2>&1 | head -60`);
  const lsOne = await exec(
    conn,
    `docker exec ${EDGE} sh -c 'for f in _shared/tallyMapping/pipeline.ts _shared/tallyMapping/accountingRegistry.ts _shared/tallySync/contentHash.ts; do if test -f /home/deno/functions/$f; then echo OK $f; else echo MISSING $f; fi; done'`,
  );
  console.log(
    JSON.stringify(
      {
        readonly: true,
        edge_container: EDGE,
        mounts_raw: mounts.out.trim(),
        deno_functions_listing: lsRoot.out,
        tallyMapping_listing: lsShared.out,
        required_file_checks: lsOne.out.trim(),
      },
      null,
      2,
    ),
  );
  conn.end();
}).connect({ host, username: user, password: pass });
