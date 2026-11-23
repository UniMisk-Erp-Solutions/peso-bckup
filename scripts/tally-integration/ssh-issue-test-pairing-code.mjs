#!/usr/bin/env node
/**
 * DEV/TEST ONLY — issue one pairing code for smoke org via SSH + psql.
 *
 * Env:
 *   DEPLOY_SSH_PASSWORD
 *   SET_TALLY_COMPANY_CONFIRM=1
 *   ISSUE_PAIRING_CONFIRM=1
 *   REVOKE_ORPHAN_PAIRING_CONFIRM=1  — consume latest unused code (plaintext unrecoverable)
 */
import { requireSshPassword, sshPsqlJson, sshPsqlMutate } from "./_sshPsqlRemote.mjs";
import {
  generatePairingCodePlaintext,
  SMOKE_ADMIN_USER,
  SMOKE_ORG,
  TALLY_COMPANY,
} from "./_pairingCodeShared.mjs";
import {
  evaluateQueueSafe,
  QUEUE_SNAPSHOT_SQL,
} from "./_queueSafeShared.mjs";

const TTL_MINUTES = 30;

export { generatePairingCodePlaintext, SMOKE_ADMIN_USER, SMOKE_ORG, TALLY_COMPANY };

const SMOKE_META_SQL = `
SELECT jsonb_build_object(
  'smoke_organization_id', '${SMOKE_ORG}',
  'tally_company_name', (SELECT tally_company_name FROM public.tally_org_connector_config WHERE organization_id = '${SMOKE_ORG}'::uuid),
  'organization_name', (SELECT name FROM public.organizations WHERE id = '${SMOKE_ORG}'::uuid)
);
`;

const READ_COMPANY_SQL = `
SELECT jsonb_build_object(
  'organization_id', '${SMOKE_ORG}',
  'tally_company_name', (SELECT tally_company_name FROM public.tally_org_connector_config WHERE organization_id = '${SMOKE_ORG}'::uuid)
);
`;

const PAIRING_STATE_SQL = `
SELECT jsonb_build_object(
  'unused_active_pairing_codes', (
    SELECT count(*)::int FROM public.tally_connector_pairing_codes
    WHERE organization_id = '${SMOKE_ORG}'::uuid AND consumed_at IS NULL AND expires_at > now()
  ),
  'latest_unused_id', (
    SELECT id FROM public.tally_connector_pairing_codes
    WHERE organization_id = '${SMOKE_ORG}'::uuid AND consumed_at IS NULL AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  )
);
`;

function setCompanyMutateSql() {
  const company = TALLY_COMPANY.replace(/'/g, "''");
  return `
INSERT INTO public.tally_org_connector_config (organization_id, tally_company_name, is_active)
VALUES ('${SMOKE_ORG}'::uuid, '${company}', true)
ON CONFLICT (organization_id) DO UPDATE
SET tally_company_name = EXCLUDED.tally_company_name, updated_at = now(), is_active = true;
`;
}

function insertPairingCodeSql(plaintext) {
  const code = plaintext.replace(/'/g, "''");
  return `
INSERT INTO public.tally_connector_pairing_codes (organization_id, code_hash, code_prefix, created_by, expires_at)
VALUES (
  '${SMOKE_ORG}'::uuid,
  encode(digest('${code}', 'sha256'), 'hex'),
  substr('${code}', 1, 4),
  '${SMOKE_ADMIN_USER}'::uuid,
  now() + make_interval(mins => ${TTL_MINUTES})
);
`;
}

const REVOKE_LATEST_UNUSED_SQL = `
UPDATE public.tally_connector_pairing_codes
SET consumed_at = now()
WHERE id = (
  SELECT id FROM public.tally_connector_pairing_codes
  WHERE organization_id = '${SMOKE_ORG}'::uuid AND consumed_at IS NULL AND expires_at > now()
  ORDER BY created_at DESC
  LIMIT 1
)
RETURNING id, code_prefix;
`;

async function loadPreflight(pass) {
  const [queue, meta] = await Promise.all([
    sshPsqlJson(QUEUE_SNAPSHOT_SQL, { password: pass }),
    sshPsqlJson(SMOKE_META_SQL, { password: pass }),
  ]);
  if (meta.smoke_organization_id !== SMOKE_ORG) {
    throw new Error(`smoke org guard failed: ${meta.smoke_organization_id}`);
  }
  return { ...queue, ...meta };
}

async function main() {
  const pass = requireSshPassword();
  const snapshot = await loadPreflight(pass);
  const queue = evaluateQueueSafe(snapshot);

  let companyOk = snapshot.tally_company_name === TALLY_COMPANY;
  const out = {
    bootstrap: "test_only_not_customer_flow",
    smoke_org: SMOKE_ORG,
    expected_company: TALLY_COMPANY,
    ...snapshot,
    queue_safe: queue.queue_safe,
    queue_errors: queue.errors,
    company_ok: companyOk,
  };

  if (!queue.queue_safe) {
    console.log(JSON.stringify({ ...out, action: "STOP", reason: "unsafe queue" }, null, 2));
    process.exit(4);
  }

  if (!companyOk) {
    if (process.env.SET_TALLY_COMPANY_CONFIRM === "1") {
      const mutate = await sshPsqlMutate(setCompanyMutateSql(), { password: pass });
      const setResult = await sshPsqlJson(READ_COMPANY_SQL, { password: pass });
      out.company_mutate_tags = mutate.commandTags;
      if (setResult.organization_id !== SMOKE_ORG || setResult.tally_company_name !== TALLY_COMPANY) {
        console.log(JSON.stringify({ ...out, action: "STOP", reason: "company read-back mismatch", setResult }, null, 2));
        process.exit(6);
      }
      out.company_set = true;
      out.tally_company_name = setResult.tally_company_name;
      companyOk = true;
      out.company_ok = true;
    } else {
      console.log(
        JSON.stringify(
          { ...out, action: "NEED_SET_TALLY_COMPANY_CONFIRM", hint: "SET_TALLY_COMPANY_CONFIRM=1" },
          null,
          2,
        ),
      );
      process.exit(5);
    }
  }

  const pairingState = await sshPsqlJson(PAIRING_STATE_SQL, { password: pass });
  out.unused_active_pairing_codes = pairingState.unused_active_pairing_codes;

  if (process.env.ISSUE_PAIRING_CONFIRM !== "1") {
    console.log(
      JSON.stringify(
        {
          ...out,
          action: "READY",
          hint: "ISSUE_PAIRING_CONFIRM=1 (use REVOKE_ORPHAN_PAIRING_CONFIRM=1 first if unused_active_pairing_codes>0)",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (pairingState.unused_active_pairing_codes > 0) {
    if (process.env.REVOKE_ORPHAN_PAIRING_CONFIRM !== "1") {
      console.log(
        JSON.stringify(
          {
            ...out,
            action: "STOP",
            reason: "unused pairing code already exists (plaintext not recoverable)",
            hint: "Run ssh-inspect-test-pairing-state.mjs then REVOKE_ORPHAN_PAIRING_CONFIRM=1 and re-run issue",
          },
          null,
          2,
        ),
      );
      process.exit(7);
    }
    const revoke = await sshPsqlMutate(REVOKE_LATEST_UNUSED_SQL, { password: pass });
    out.revoked_orphan = { commandTags: revoke.commandTags };
    const after = await sshPsqlJson(PAIRING_STATE_SQL, { password: pass });
    if (after.unused_active_pairing_codes > 0) {
      console.log(JSON.stringify({ ...out, action: "STOP", reason: "revoke failed", after }, null, 2));
      process.exit(8);
    }
  }

  const plaintext = generatePairingCodePlaintext();
  const prefix = plaintext.slice(0, 4);
  const mutateInsert = await sshPsqlMutate(insertPairingCodeSql(plaintext), { password: pass });
  const verifySql = `
SELECT jsonb_build_object(
  'organization_id', '${SMOKE_ORG}',
  'inserted', (
    SELECT count(*)::int FROM public.tally_connector_pairing_codes
    WHERE organization_id = '${SMOKE_ORG}'::uuid AND code_prefix = '${prefix}'
      AND consumed_at IS NULL AND expires_at > now()
  )
);
`;
  const verify = await sshPsqlJson(verifySql, { password: pass });

  console.log(
    JSON.stringify(
      {
        ...out,
        action: "ISSUED",
        organization_id: verify.organization_id,
        expires_in_minutes: TTL_MINUTES,
        pairing_code_prefix: `${prefix}****`,
        insert_tags: mutateInsert.commandTags,
        inserted: verify.inserted,
      },
      null,
      2,
    ),
  );

  if (verify.inserted !== 1 || verify.organization_id !== SMOKE_ORG) {
    process.exit(1);
  }
  console.error("\n=== ONE-TIME TEST PAIRING CODE (smoke org only — copy now) ===");
  console.error(plaintext);
  console.error("=== Use: PesoWise-Tally-Agent.exe pair ... ===\n");
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("ssh-issue-test-pairing-code.mjs");
if (isMain) {
  main().catch((e) => {
    console.log(JSON.stringify({ error: e.message ?? String(e) }, null, 2));
    process.exit(1);
  });
}
