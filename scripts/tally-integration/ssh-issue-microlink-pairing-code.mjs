#!/usr/bin/env node
/**
 * Issue one pairing code for MicroLink org via Coolify SSH (test/dev).
 * Env: coolify_ssh_password.txt or COOLIFY_SSH_PASSWORD
 *      ISSUE_PAIRING_CONFIRM=1
 *      PESO_TALLY_COMPANY (default MicroLink)
 */
import crypto from "node:crypto";
import { spawnSync } from "child_process";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
import { sshPsqlJson, sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import { MICROLINK_ORG } from "./_queueSafeShared.mjs";
import { generatePairingCodePlaintext } from "./ssh-issue-test-pairing-code.mjs";

const MICROLINK_ADMIN = "790267ca-f168-4cae-91c3-c3a7345dfcde";
const DEFAULT_COMPANY = process.env.PESO_TALLY_COMPANY ?? "MicroLink";

function insertPairingCodeSql(plaintext) {
  const code = plaintext.replace(/'/g, "''");
  return `
INSERT INTO public.tally_connector_pairing_codes (organization_id, code_hash, code_prefix, created_by, expires_at)
VALUES (
  '${MICROLINK_ORG}'::uuid,
  encode(digest('${code}', 'sha256'), 'hex'),
  substr('${code}', 1, 4),
  '${MICROLINK_ADMIN}'::uuid,
  now() + make_interval(mins => 30)
);
`;
}

function setCompanySql(company) {
  const c = company.replace(/'/g, "''");
  return `
INSERT INTO public.tally_org_connector_config (organization_id, tally_company_name, is_active)
VALUES ('${MICROLINK_ORG}'::uuid, '${c}', true)
ON CONFLICT (organization_id) DO UPDATE
SET tally_company_name = EXCLUDED.tally_company_name, updated_at = now(), is_active = true;
`;
}

async function main() {
  if (process.env.ISSUE_PAIRING_CONFIRM !== "1") {
    console.error("Set ISSUE_PAIRING_CONFIRM=1");
    process.exit(2);
  }
  const pass = requireCoolifySshPassword();
  await sshPsqlMutate(setCompanySql(DEFAULT_COMPANY), { password: pass });
  const plaintext = generatePairingCodePlaintext();
  await sshPsqlMutate(insertPairingCodeSql(plaintext), { password: pass });
  const verify = await sshPsqlJson(
    `SELECT jsonb_build_object('org','${MICROLINK_ORG}','company',(SELECT tally_company_name FROM tally_org_connector_config WHERE organization_id='${MICROLINK_ORG}'))`,
    { password: pass },
  );
  console.log(JSON.stringify({ ...verify, pairing_code: plaintext }, null, 2));

  const { join, dirname } = await import("path");
  const { fileURLToPath } = await import("url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const pair = spawnSync(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", join(root, "scripts/tally-integration/pair-org-agent.ps1")],
    {
      env: { ...process.env, PESO_PAIRING_CODE: plaintext, PESO_TALLY_COMPANY: DEFAULT_COMPANY },
      encoding: "utf-8",
    },
  );
  process.stdout.write(pair.stdout || "");
  process.stderr.write(pair.stderr || "");
  process.exit(pair.status ?? 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
