#!/usr/bin/env node
/**
 * READ ONLY — inspect container files + try Deno module graph (no invoke).
 * Env: DEPLOY_SSH_PASSWORD
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { Client } from "ssh2";

const pass = process.env.DEPLOY_SSH_PASSWORD;
const user = process.env.DEPLOY_SSH_USER ?? "hasto";
const host = process.env.DEPLOY_SSH_HOST ?? "192.168.23.46";
const EDGE = "supabase-edge-functions-kar0ro1k6jiyfxzzw7acnsza";
const DENO = "/home/deno/functions";
const SERVICE_ID = "kar0ro1k6jiyfxzzw7acnsza";
const HOST_VOL = `/data/coolify/services/${SERVICE_ID}/volumes/functions`;
const LOCAL = join(process.cwd(), "supabase/functions/_shared/tallyMapping/accountingRegistry.ts");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
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

if (!pass) {
  console.error("Set DEPLOY_SSH_PASSWORD");
  process.exit(2);
}

const localHash = sha256(readFileSync(LOCAL));

const conn = new Client();
conn.on("ready", async () => {
  const sudop = pass.replace(/'/g, `'\\''`);
  const cmds = {
    ls: `docker exec ${EDGE} ls -la ${DENO}/_shared/tallyMapping/accountingRegistry.ts`,
    head: `docker exec ${EDGE} head -5 ${DENO}/_shared/tallyMapping/accountingRegistry.ts`,
    pipeline_import: `docker exec ${EDGE} grep -n accountingRegistry ${DENO}/_shared/tallyMapping/pipeline.ts | head -3`,
    container_sha: `docker exec ${EDGE} sha256sum ${DENO}/_shared/tallyMapping/accountingRegistry.ts`,
    host_sha: `echo '${sudop}' | sudo -S sha256sum ${HOST_VOL}/_shared/tallyMapping/accountingRegistry.ts 2>/dev/null || echo HOST_SHA_UNAVAILABLE`,
    edge_containers: `docker ps --format '{{.Names}}' | grep -i edge || true`,
    deno_check: `docker exec ${EDGE} sh -c 'command -v deno >/dev/null && deno check --no-lock ${DENO}/run-tally-sync-delivery/index.ts 2>&1 | head -20 || echo DENO_CLI_NOT_IN_CONTAINER'`,
    logs_tail: `docker logs ${EDGE} --tail 5 2>&1`,
  };
  const out = { local_sha256: localHash };
  for (const [k, c] of Object.entries(cmds)) {
    const r = await exec(conn, c);
    out[k] = { code: r.code, text: (r.out + r.errOut).trim().slice(0, 800) };
  }
  console.log(JSON.stringify(out, null, 2));
  conn.end();
}).connect({ host, username: user, password: pass });
