#!/usr/bin/env node
/**
 * READ-ONLY: resolve public anon key for pesowise-backup Supabase from Kong container env.
 * Does not print service_role.
 */
import { requireSshPassword } from "./_sshPsqlRemote.mjs";

const KONG = process.env.DEPLOY_KONG_CONTAINER ?? "supabase-kong-kar0ro1k6jiyfxzzw7acnsza";

async function main() {
  const pass = requireSshPassword();
  const bash = `docker exec ${KONG} printenv ANON_KEY`;
  const { Client } = await import("ssh2");
  const key = await new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(bash, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          let out = "";
          stream.on("data", (d) => {
            out += d;
          });
          stream.on("close", (code) => {
            conn.end();
            if (code !== 0) reject(new Error(`kong ANON_KEY exit ${code}`));
            else resolve(out.trim().replace(/\r/g, ""));
          });
        });
      })
      .on("error", reject)
      .connect({
        host: process.env.DEPLOY_SSH_HOST ?? "192.168.23.46",
        username: process.env.DEPLOY_SSH_USER ?? "hasto",
        password: pass,
        readyTimeout: 20000,
      });
  });
  if (!key.startsWith("eyJ")) throw new Error("Unexpected ANON_KEY shape");
  const probeUrl =
    "https://pesowise-backup-supabase.unimisk.com/rest/v1/rpc/exchange_tally_connector_pairing_v1";
  const probe = await fetch(probeUrl, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_pairing_code: "00000000",
      p_device_name: "probe",
      p_installation_id: "12345678",
      p_connector_version: "probe",
    }),
  });
  const body = (await probe.text()).slice(0, 200);
  const gateway401 = probe.status === 401 && body.includes('"message":"Unauthorized"');
  console.log(
    JSON.stringify(
      {
        source: "kong_printenv_ANON_KEY",
        url: "https://pesowise-backup-supabase.unimisk.com",
        anon_key_prefix: `${key.slice(0, 12)}…`,
        probe_status: probe.status,
        gateway_rejects_jwt: gateway401,
        probe_preview: body,
        ...(process.env.PRINT_ANON_KEY === "1" ? { anon_key: key } : {}),
      },
      null,
      2,
    ),
  );
  if (process.env.PRINT_ANON_KEY === "1") {
    console.error("\n=== PUBLIC ANON KEY (for pair --anon-key) ===\n");
    console.error(key);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
