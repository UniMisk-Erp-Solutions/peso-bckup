#!/usr/bin/env node
/** READ-ONLY smoke-org pairing + company state (no secrets/hashes). */
import { requireSshPassword, sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { SMOKE_ORG } from "./_queueSafeShared.mjs";

const SQL = `
SELECT jsonb_build_object(
  'smoke_organization_id', '${SMOKE_ORG}',
  'tally_company_name', (SELECT tally_company_name FROM public.tally_org_connector_config WHERE organization_id = '${SMOKE_ORG}'::uuid),
  'unused_active_pairing_codes', (
    SELECT count(*)::int FROM public.tally_connector_pairing_codes
    WHERE organization_id = '${SMOKE_ORG}'::uuid AND consumed_at IS NULL AND expires_at > now()
  ),
  'recent_pairing_codes', (
    SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::jsonb)
    FROM (
      SELECT id, code_prefix, created_at, expires_at, consumed_at
      FROM public.tally_connector_pairing_codes
      WHERE organization_id = '${SMOKE_ORG}'::uuid
      ORDER BY created_at DESC
      LIMIT 5
    ) t
  )
);
`;

async function main() {
  const pass = requireSshPassword();
  const data = await sshPsqlJson(SQL, { password: pass });
  console.log(JSON.stringify({ readonly: true, ...data }, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify({ error: e.message ?? String(e) }, null, 2));
  process.exit(1);
});
