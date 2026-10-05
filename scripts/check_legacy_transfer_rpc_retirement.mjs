/**
 * Migration 1400 readiness checker (20260824140000_revoke_legacy_transfer_offer_rpcs.sql).
 *
 * That migration REVOKEs EXECUTE on the legacy (pre-v2) propose_balance_transfer_offer
 * / accept_balance_transfer_offer RPCs. Revoking them while any deployed
 * frontend still calls the bare (non-_v2) name would break that frontend
 * outright -- this script is the readiness gate for applying migration 1400
 * (see RELEASE-PREP §17/§18/§26 and Documentations MD/historical-balance-anchors-v2.md).
 *
 * Note: written as plain .mjs (not .ts) deliberately -- this Node runtime
 * (v20.15.1 in this repo's environment) cannot execute a .ts file directly
 * (ERR_UNKNOWN_FILE_EXTENSION; confirmed via the repo's own pre-existing
 * `npm run i18n:check`, which fails identically for the same reason). A
 * .ts script here would look correct and silently never run.
 *
 * Scans ONLY runtime application source (src/) for an exact, QUOTED string
 * match:
 *
 *   "propose_balance_transfer_offer"    <- bare v1, FLAGGED
 *   "propose_balance_transfer_offer_v2" <- v2, allowed, not flagged
 *
 * The v1 name being a string PREFIX of the v2 name is exactly why this
 * requires the closing quote immediately after the bare name (a plain
 * substring search would false-positive on every "_v2" call site). It
 * intentionally does NOT also require a literal `rpc(` prefix immediately
 * before the string -- this codebase calls through varying wrappers
 * (`supabase.rpc(...)`, `(supabase.rpc as any)(...)`, helper functions) and
 * an unquoted object key (as in the generated Supabase types.ts) can never
 * match a quote-anchored pattern anyway, so the quote boundary alone is
 * both necessary and sufficient to isolate real string-literal RPC-name
 * references from everything else.
 *
 * Deliberately does NOT scan supabase/migrations/, supabase/rollbacks/, or
 * Documentations MD/ -- a migration DEFINING or REVOKING the v1 function, or
 * a doc DESCRIBING it, is not a runtime caller and must not block this gate.
 *
 * Also excludes __tests__ directories: a unit test asserting against a
 * MOCKED rpc() call never reaches a real database function, so it is not a
 * "runtime caller" for the purpose of this gate either -- notably this
 * repo's own src/lib/__tests__/legacyTransferOfferRpcRetirement.test.ts
 * legitimately contains the bare v1 string literals (it tests this exact
 * matcher), which would otherwise false-positive this script against
 * itself.
 *
 * Run: node scripts/check_legacy_transfer_rpc_retirement.mjs
 * Exit code 0 + "READY_TO_REVOKE=true"  -- safe to apply migration 1400.
 * Exit code 1 + "READY_TO_REVOKE=false" -- at least one runtime v1 caller
 *   remains, or no v2 caller was found at all (suspicious -- migration to v2
 *   may not have happened yet, or transfer offers were removed entirely;
 *   either way, revoking v1 is not obviously safe).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "..", "src");
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

const LEGACY_NAMES = ["propose_balance_transfer_offer", "accept_balance_transfer_offer"];
const V2_NAMES = ["propose_balance_transfer_offer_v2", "accept_balance_transfer_offer_v2"];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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

function findRuntimeCalls(files, rpcName) {
  // Anchored: the bare name must sit directly between matching quote
  // characters -- "propose_balance_transfer_offer_v2" never matches this
  // pattern for rpcName="propose_balance_transfer_offer".
  const pattern = new RegExp(`(["'\`])${rpcName}\\1`);
  const hits = [];
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

function main() {
  const files = walk(SRC_DIR);

  const legacyHits = LEGACY_NAMES.flatMap((name) => findRuntimeCalls(files, name));
  const v2Hits = V2_NAMES.flatMap((name) => findRuntimeCalls(files, name));

  console.log(`Scanned ${files.length} files under src/.\n`);

  if (legacyHits.length > 0) {
    console.log("BLOCKING -- runtime call(s) to the bare (v1) RPC name found:");
    for (const h of legacyHits) console.log(`  ${h.file}:${h.line}  ${h.text}`);
    console.log("");
  } else {
    console.log("OK -- no runtime caller of the bare (v1) propose/accept RPC names.\n");
  }

  if (v2Hits.length === 0) {
    console.log(
      "WARNING -- no runtime caller of the v2 RPC names was found either. " +
        "This is suspicious: either transfer offers were removed from the app " +
        "entirely, or the v2 cutover has not actually happened yet. Revoking v1 " +
        "is NOT obviously safe until this is understood.\n",
    );
  } else {
    console.log(`OK -- v2 RPCs are in active use (${v2Hits.length} call site(s)):`);
    for (const h of v2Hits) console.log(`  ${h.file}:${h.line}`);
    console.log("");
  }

  const ready = legacyHits.length === 0 && v2Hits.length > 0;
  console.log(`READY_TO_REVOKE=${ready}`);
  process.exit(ready ? 0 : 1);
}

main();
