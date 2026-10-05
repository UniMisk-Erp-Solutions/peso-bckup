/**
 * RELEASE-PREP §17/§18 — Historical Balance V2 Phase 1 manifest guard.
 *
 * scripts/historicalBalanceV2Phase1Migrations.mjs is the single source of
 * truth for "what Phase 1 actually is", specifically BECAUSE the six
 * migrations' filenames do not sort into their correct deployment order --
 * 20260824140000 (the legacy transfer-offer RPC revoke) sorts before
 * 20260826100000 (the capability probe) even though it must be applied
 * LAST, after a separate frontend cutover. This test fails loudly if that
 * manifest is ever edited to accidentally include the deferred migration,
 * or to drop one of the real Phase 1 files.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

// Imported as a plain ESM module -- this file has no side effects at
// import time other than exporting the two constants (main() only runs
// under Node's own `if` guard via direct execution, not on import... but
// this module calls main() unconditionally at the bottom, so importing it
// DOES run main() and print to the console. That's acceptable inside a
// test (harmless stdout), and confirms the manifest's own self-check runs
// cleanly as an import side effect too, not just via `node script.mjs`.
import {
  PHASE_1_MIGRATIONS,
  DEFERRED_UNTIL_FRONTEND_CUTOVER,
} from "../../../scripts/historicalBalanceV2Phase1Migrations.mjs";

describe("Historical Balance V2 Phase 1 manifest", () => {
  it("contains exactly the six Phase 1 files, in deployment order", () => {
    expect(PHASE_1_MIGRATIONS).toEqual([
      "20260824100000_historical_balance_anchors_schema.sql",
      "20260824110000_historical_balance_anchors_engine.sql",
      "20260824120000_balance_import_v2.sql",
      "20260824130000_historical_balance_history_v2.sql",
      "20260826110000_balance_reverse_import_v2.sql",
      "20260826100000_balance_historical_v2_capabilities.sql",
    ]);
  });

  it("never includes the deferred migration (the exact accident this manifest prevents)", () => {
    expect(PHASE_1_MIGRATIONS).not.toContain(DEFERRED_UNTIL_FRONTEND_CUTOVER);
  });

  it("identifies the deferred migration as the legacy transfer-offer RPC revoke", () => {
    expect(DEFERRED_UNTIL_FRONTEND_CUTOVER).toBe("20260824140000_revoke_legacy_transfer_offer_rpcs.sql");
  });

  it("every referenced migration file actually exists in supabase/migrations/", () => {
    for (const file of [...PHASE_1_MIGRATIONS, DEFERRED_UNTIL_FRONTEND_CUTOVER]) {
      expect(fs.existsSync(path.join(MIGRATIONS_DIR, file)), `missing migration file: ${file}`).toBe(true);
    }
  });

  it("demonstrates the actual filename-sort hazard this manifest exists to prevent", () => {
    // A naive "apply all pending migrations in filename order" over the
    // real files would NOT place the deferred revoke last -- both the
    // capability probe (20260826100000) and the reversal engine
    // (20260826110000) sort after it, even though the revoke must be
    // applied LAST, after a separate frontend cutover.
    const allSortedByFilename = [...PHASE_1_MIGRATIONS, DEFERRED_UNTIL_FRONTEND_CUTOVER].sort();
    const naiveIndexOfDeferred = allSortedByFilename.indexOf(DEFERRED_UNTIL_FRONTEND_CUTOVER);
    // At least one real Phase 1 file (the capability probe and/or the
    // reversal engine) sorts after the deferred revoke by filename -- that's
    // the exact hazard: a naive chronological apply would reach 1400 before
    // finishing every real Phase 1 file, not after all of them.
    expect(naiveIndexOfDeferred).toBeLessThan(allSortedByFilename.length - 1);
  });
});
