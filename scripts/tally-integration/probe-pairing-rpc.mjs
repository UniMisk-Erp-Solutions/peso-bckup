#!/usr/bin/env node
/**
 * Non-mutating probe: exchange RPC auth + digest (invalid code → business error, not 401/digest missing).
 */
import { loadBackupAnonKey } from "./_loadBackupAnonKey.mjs";

const URL = (process.env.TALLY_VALIDATE_SUPABASE_URL ?? "https://pesowise-backup-supabase.unimisk.com").replace(
  /\/$/,
  "",
);

async function loadAnon() {
  if (process.env.PRINT_ANON_KEY_FROM_SSH && process.env.DEPLOY_SSH_PASSWORD) {
    const { spawnSync } = await import("child_process");
    const r = spawnSync(process.execPath, ["scripts/tally-integration/resolve-backup-anon-key.mjs"], {
      env: { ...process.env, PRINT_ANON_KEY: "1" },
      encoding: "utf8",
      cwd: process.cwd(),
    });
    const m = (r.stdout + r.stderr).match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (m) return m[0];
  }
  return loadBackupAnonKey();
}

async function main() {
  const anon = await loadAnon();
  const endpoint = `${URL}/rest/v1/rpc/exchange_tally_connector_pairing_v1`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_pairing_code: "00000000",
      p_device_name: "probe",
      p_installation_id: "12345678",
      p_connector_version: "probe",
    }),
  });
  const text = await res.text();
  let preview = text.slice(0, 300);
  const ok =
    res.status !== 401 &&
    !preview.includes("function digest(text, unknown) does not exist") &&
    !preview.includes('"message":"Unauthorized"');
  console.log(
    JSON.stringify(
      {
        endpoint,
        status: res.status,
        pairing_rpc_ready: ok,
        preview,
        hint: ok
          ? "Gateway + digest OK; invalid code should return 22023-style error"
          : "Apply apply-pgcrypto-search-path-only.mjs and resolve-backup-anon-key.mjs",
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
