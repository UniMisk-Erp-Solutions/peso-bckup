#!/usr/bin/env node
import { Client } from "ssh2";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
import { DEFAULT_HOST, DEFAULT_USER } from "./_sshPsqlRemote.mjs";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: node _run-delivery-only.mjs <job_id>");
  process.exit(2);
}
const URL = "https://pesowise-backup-supabase.unimisk.com".replace(/\/$/, "");
const KONG = process.env.DEPLOY_KONG_CONTAINER ?? "supabase-kong-kar0ro1k6jiyfxzzw7acnsza";
const pass = requireCoolifySshPassword();

function sshExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d) => (out += d));
      stream.stderr.on("data", (d) => (out += d));
      stream.on("close", (code) => (code !== 0 ? reject(new Error(out)) : resolve(out)));
    });
  });
}

const conn = new Client();
await new Promise((resolve, reject) => {
  conn.on("ready", resolve).on("error", reject).connect({
    host: DEFAULT_HOST,
    username: DEFAULT_USER,
    password: pass,
    readyTimeout: 30000,
  });
});
const srk = (await sshExec(conn, `docker exec ${KONG} printenv SUPABASE_SERVICE_ROLE_KEY | tr -d '\\r'`)).trim();
conn.end();

const res = await fetch(`${URL}/functions/v1/run-tally-sync-job`, {
  method: "POST",
  headers: { Authorization: `Bearer ${srk}`, apikey: srk, "Content-Type": "application/json" },
  body: JSON.stringify({ job_id: jobId, delivery_only: true }),
});
const body = await res.text();
console.log(res.status, body.slice(0, 2000));
