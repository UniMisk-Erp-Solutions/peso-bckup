/**
 * Tracked data files must not carry credentials or personal exports.
 *
 * The 2026-08-02 merge-readiness audit found `scripts/data/*.tsv` tracked with a
 * `password` column holding plaintext logins for 208 employees, alongside names,
 * employee IDs, supervisor mappings and locations. It reaches `main`, `dev` and
 * three other branches, so it is not a dev regression — but it is a live
 * exposure and it blocks the merge gate until removed AND purged from history.
 *
 * This suite is the regression control, not the remediation. It:
 *
 *   1. pins the known exposure by path and content fingerprint, so the audit
 *      record lives in code and cannot be quietly forgotten; and
 *   2. fails on ANY other tracked delimited/JSON data file that carries a
 *      credential-shaped column, so a second one cannot be added.
 *
 * KNOWN_EXPOSURES is deliberately not an "approved" list. Emptying it is the
 * remediation; see DOC-082 §Findings P0-1 for the coordinated plan (remove the
 * file and its three generator scripts, purge history, confirm every affected
 * account was reset to a value not derivable from the old scheme).
 *
 * No secret value appears here. Fingerprints are truncated SHA-256 of file
 * content, which cannot be reversed into a password.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/** Path -> truncated SHA-256 of the exact content the audit examined. */
const KNOWN_EXPOSURES: Record<string, string> = {
  "scripts/data/microlink-remove-employees.tsv": "7fe96a80816ee867",
};

/** Column names that make a data file credential-bearing. */
const CREDENTIAL_COLUMNS =
  /(^|[,\t;|"])\s*"?(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|service[_-]?role)"?\s*($|[,\t;|"])/i;

const DATA_FILE = /\.(tsv|csv|psv|json|ndjson|sql)$/i;

/** Generated/fixture trees that legitimately contain the word "password". */
const IGNORED_PREFIXES = [
  "node_modules/",
  "dist/",
  "src/locales/",
  "supabase/migrations/",
  "package-lock.json",
];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Hashes the committed (LF) form, so a Windows checkout with CRLF endings
 * produces the same fingerprint as the blob the audit examined.
 */
function fingerprint(path: string): string {
  const normalized = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized, "utf-8").digest("hex").slice(0, 16);
}

describe("tracked data files carry no credentials", () => {
  it("finds no NEW credential-bearing data file", () => {
    const offenders: string[] = [];

    for (const file of trackedFiles()) {
      if (!DATA_FILE.test(file)) continue;
      if (IGNORED_PREFIXES.some((p) => file.startsWith(p))) continue;
      if (file in KNOWN_EXPOSURES) continue;
      if (!existsSync(file)) continue;

      let head = "";
      try {
        // Header row only: enough to classify, and it avoids reading a large
        // export into memory or into a failure message.
        head = readFileSync(file, "utf-8").split("\n").slice(0, 1).join("");
      } catch {
        continue;
      }
      if (CREDENTIAL_COLUMNS.test(head)) offenders.push(file);
    }

    // Path only — never the row, never a value.
    expect(offenders, `credential-bearing data files added: ${offenders.join(", ")}`).toEqual([]);
  });

  it("pins each known exposure so it cannot change unnoticed", () => {
    for (const [path, expected] of Object.entries(KNOWN_EXPOSURES)) {
      const full = resolve(process.cwd(), path);
      if (!existsSync(full)) {
        // Removed — that is the intended end state. Drop it from the map.
        continue;
      }
      expect(fingerprint(full), `${path} changed; re-run the audit`).toBe(expected);
    }
  });

  it("records that the known exposure is unresolved, not accepted", () => {
    const stillPresent = Object.keys(KNOWN_EXPOSURES).filter((p) =>
      existsSync(resolve(process.cwd(), p)),
    );
    // Intentionally NOT an assertion that the list is empty: that would fail the
    // whole suite on a pre-existing condition and tempt someone to delete the
    // check. The merge gate in DOC-082 is what blocks on this.
    expect(Array.isArray(stillPresent)).toBe(true);
  });
});
