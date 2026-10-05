/**
 * Historical Balance Anchor V2 -- explicit Phase 1 migration manifest.
 *
 * WHY THIS EXISTS: the seven migrations for this feature do not sort into
 * their correct deployment order by filename/timestamp --
 * 20260824140000_revoke_legacy_transfer_offer_rpcs.sql (the legacy
 * transfer-offer RPC revoke) sorts BEFORE 20260826100000_balance_historical_
 * v2_capabilities.sql and 20260826110000_balance_reverse_import_v2.sql
 * (the capability probe and the atomic import-reversal engine), even though
 * the revoke must be applied LAST, and only after a separate frontend
 * deployment and a compatibility window in between (see RELEASE-PREP
 * §15-18/§32-34 and Documentations MD/historical-balance-anchors-v2.md
 * §5/§11/§12). A generic "apply every pending migration, in filename order"
 * command would revoke the legacy RPCs before the capability probe or the
 * reversal engine even exist, and before any V2 frontend has been deployed
 * to not need them.
 *
 * This manifest is the single source of truth for "what Phase 1 actually
 * is" -- an engineer or script preparing a Phase 1 apply should read this
 * list, not scan the migrations directory and eyeball timestamps. It is
 * additive tooling only: this file EXECUTES NOTHING. It contains no SQL
 * connection, no SSH, no credentials. If an SSH-based apply runner is ever
 * built from this manifest, it must resolve credentials exclusively via
 * scripts/_ssh_credentials.py's load_ssh_credentials() (env vars / a
 * gitignored local file / interactive prompt) -- never a literal secret in
 * this or any other tracked file.
 *
 * Run: node scripts/historicalBalanceV2Phase1Migrations.mjs
 * Prints the Phase 1 list and explicitly confirms 1400 is excluded. Exits
 * non-zero (a self-check, should never actually trigger) if the deferred
 * migration is ever accidentally added to PHASE_1_MIGRATIONS above.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "supabase", "migrations");

/** Apply these six, together, in this exact order. Nothing else. */
export const PHASE_1_MIGRATIONS = [
  "20260824100000_historical_balance_anchors_schema.sql",
  "20260824110000_historical_balance_anchors_engine.sql",
  "20260824120000_balance_import_v2.sql",
  "20260824130000_historical_balance_history_v2.sql",
  "20260826110000_balance_reverse_import_v2.sql",
  "20260826100000_balance_historical_v2_capabilities.sql",
];

/**
 * Deliberately NOT in PHASE_1_MIGRATIONS. Apply ONLY after every precondition
 * in Documentations MD/historical-balance-anchors-v2.md §11 is independently
 * confirmed against the actual deployed environment -- V2 frontend live,
 * feature flag tested both states, zero runtime callers of the bare v1
 * transfer-offer RPC names (scripts/check_legacy_transfer_rpc_retirement.mjs
 * reports READY_TO_REVOKE=true against the DEPLOYED build, not just this
 * repo's source), built assets scanned, no supported rollback still on v1.
 */
export const DEFERRED_UNTIL_FRONTEND_CUTOVER = "20260824140000_revoke_legacy_transfer_offer_rpcs.sql";

function assertManifestIntegrity() {
  if (PHASE_1_MIGRATIONS.includes(DEFERRED_UNTIL_FRONTEND_CUTOVER)) {
    throw new Error(
      `Manifest integrity violation: ${DEFERRED_UNTIL_FRONTEND_CUTOVER} must never appear in ` +
        `PHASE_1_MIGRATIONS. This is the exact accidental-early-revoke this manifest exists to prevent.`,
    );
  }
  for (const file of [...PHASE_1_MIGRATIONS, DEFERRED_UNTIL_FRONTEND_CUTOVER]) {
    if (!fs.existsSync(path.join(MIGRATIONS_DIR, file))) {
      throw new Error(`Manifest references a migration file that does not exist: ${file}`);
    }
  }
}

function main() {
  assertManifestIntegrity();
  console.log("Historical Balance Anchor V2 -- Phase 1 migration manifest\n");
  console.log("Apply these, in this order, in one Phase 1 rollout:");
  PHASE_1_MIGRATIONS.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log(
    `\nDEFERRED (do NOT apply in Phase 1): ${DEFERRED_UNTIL_FRONTEND_CUTOVER}\n` +
      "  Apply this only after V2 frontend cutover, a compatibility window, and every\n" +
      "  precondition in historical-balance-anchors-v2.md §11 is confirmed against the\n" +
      "  actually deployed environment.\n",
  );
  console.log("Manifest integrity check: PASSED (deferred migration confirmed excluded from Phase 1).");
}

main();
