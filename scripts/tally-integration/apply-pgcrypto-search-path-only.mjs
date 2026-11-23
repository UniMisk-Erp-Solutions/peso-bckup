#!/usr/bin/env node
/** Apply 20261007160000_tally_connector_pgcrypto_search_path.sql on backup DB via SSH. */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { requireSshPassword, sshPsqlMutate, sshPsqlJson } from "./_sshPsqlRemote.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sql = readFileSync(
  resolve(root, "supabase/migrations/20261007160000_tally_connector_pgcrypto_search_path.sql"),
  "utf-8",
);

const VERIFY = `
SELECT jsonb_build_object(
  'exchange_path', (
    SELECT proconfig::text FROM pg_proc WHERE proname = 'exchange_tally_connector_pairing_v1' LIMIT 1
  )
);
`;

async function main() {
  const pass = requireSshPassword();
  const mutate = await sshPsqlMutate(sql, { password: pass });
  const verify = await sshPsqlJson(VERIFY, { password: pass });
  console.log(JSON.stringify({ applied: true, mutate_tags: mutate.commandTags, verify }, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
