/**
 * RELEASE-PREP §7/§17/§19 — legacy transfer-offer RPC retirement guard.
 *
 * Migration 20260824140000_revoke_legacy_transfer_offer_rpcs.sql revokes
 * EXECUTE on the pre-v2 propose_balance_transfer_offer / accept_balance_
 * transfer_offer functions. Revoking them while any runtime application
 * code still calls the bare (non-_v2) name would break that code outright.
 * This test is the same check as scripts/check_legacy_transfer_rpc_retirement.mjs,
 * wired into the normal test suite so a regression is caught on every run,
 * not only when someone remembers to run the standalone script.
 *
 * Scans ONLY runtime source (src/), never supabase/migrations/,
 * supabase/rollbacks/ or Documentations MD/ -- a migration that DEFINES or
 * REVOKES the v1 function, or a doc that DESCRIBES it, is not a runtime
 * caller and must not fail this test.
 *
 * The v1 name is a string PREFIX of the v2 name ("propose_balance_transfer_offer"
 * vs "..._v2"), so the match requires the closing quote immediately after
 * the bare name -- a plain substring search would false-positive on every
 * legitimate _v2 call site.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC_DIR = path.resolve(process.cwd(), "src");
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

const LEGACY_NAMES = ["propose_balance_transfer_offer", "accept_balance_transfer_offer"] as const;
const V2_NAMES = ["propose_balance_transfer_offer_v2", "accept_balance_transfer_offer_v2"] as const;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // __tests__ is excluded entirely, not just this file: a unit test
    // asserting against a MOCKED rpc() call never reaches a real database
    // function, so it isn't a "runtime caller" for this guard's purpose --
    // and this file's own LEGACY_NAMES/V2_NAMES literals above would
    // otherwise false-match themselves regardless of a single-file exclusion.
    if (entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function findExactStringReferences(files: string[], name: string): Hit[] {
  const pattern = new RegExp(`(["'\`])${name}\\1`);
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (pattern.test(line)) {
        hits.push({ file: path.relative(process.cwd(), file), line: idx + 1, text: line.trim() });
      }
    });
  }
  return hits;
}

// walk() already excludes every __tests__ directory (including this file's
// own), so this file's LEGACY_NAMES/V2_NAMES literals never self-match.
const files = walk(SRC_DIR);

describe("legacy transfer-offer RPC retirement guard", () => {
  it.each(LEGACY_NAMES)(
    "no runtime source references the bare v1 RPC name %s",
    (name) => {
      const hits = findExactStringReferences(files, name);
      expect(hits).toEqual([]);
    },
  );

  it.each(V2_NAMES)("runtime source actually calls the v2 RPC %s (cutover really happened)", (name) => {
    const hits = findExactStringReferences(files, name);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("the v1 name being a prefix of the v2 name does not cause a false positive", () => {
    // Self-check on the matcher itself, not the codebase: a file containing
    // ONLY the _v2 string must never match the bare-name pattern.
    const pattern = new RegExp(`(["'\`])propose_balance_transfer_offer\\1`);
    expect(pattern.test('rpc("propose_balance_transfer_offer_v2", {})')).toBe(false);
    expect(pattern.test('rpc("propose_balance_transfer_offer", {})')).toBe(true);
  });
});
