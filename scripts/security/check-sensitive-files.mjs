#!/usr/bin/env node
/**
 * Repository sensitive-data scanner.
 *
 * Exists because `scripts/data/microlink-remove-employees.tsv` — 208 real
 * employee records including plaintext logins — sat tracked in this repository
 * across five branches until the 2026-08-02 audit. Deleting it is not a control;
 * this is.
 *
 *   npm run security:secrets            scan tracked files
 *   npm run security:secrets -- --staged  scan only what is staged
 *
 * Exits 0 clean, 1 on detection. Prints category and path ONLY — never a matched
 * value, never a row. Offline, and portable across Windows and Linux.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import process from "process";

const STAGED_ONLY = process.argv.includes("--staged");

/** Never scanned: generated, vendored, or the documented synthetic fixtures. */
const SKIP_PREFIX = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".git/",
  "scripts/data/examples/",
  ".local-sensitive-data/",
];

/**
 * Files allowed to discuss secrets without carrying one: the security docs, the
 * scanner itself, and its tests. Excluding them prevents the guard tripping on
 * its own vocabulary, which is how such guards get deleted.
 */
const SELF = [
  "scripts/security/check-sensitive-files.mjs",
  "src/__tests__/secretsRegression.test.ts",
  "src/__tests__/credentialDataFiles.test.ts",
  "src/__tests__/sensitiveDataPolicy.test.ts",
  "Documentations MD/sensitive-local-data-policy.md",
  "Documentations MD/security-sweep-and-merge-readiness-2026-08-02.md",
  "Documentations MD/post-history-rewrite-clone-instructions.md",
  "Documentations MD/index.md",
  "CLAUDE.md",
  ".gitignore",
];

/** Paths that must never come back, whatever they contain. */
const FORBIDDEN_PATHS = [
  "scripts/data/microlink-remove-employees.tsv",
  "scripts/data/microlink-supervisor-emails.json",
  "scripts/data/microlink-bulk-import.csv",
  "scripts/sync-microlink-passwords.mjs",
  "scripts/sync-microlink-passwords-service.mjs",
  ".env",
];

const FORBIDDEN_PREFIX = [".local-sensitive-data/", "scripts/data/private/", "scripts/data/local/"];

/** Extensions that carry bulk data or archives. */
const RISKY_EXT = /\.(har|dump|sql\.gz|bak|backup|pfx|p12|pem|key|zip|tar|tgz|tar\.gz|7z|rar)$/i;

/** Content patterns. Each must be specific enough not to fire on prose. */
const CONTENT_RULES = [
  ["service-role-jwt", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[^."'\s]*service_role[^."'\s]*\.[A-Za-z0-9_-]{10,}/],
  ["supabase-secret-key", /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["har-authorization-header", /"name"\s*:\s*"[Aa]uthorization"\s*,\s*"value"\s*:\s*"Bearer\s+\S/],
  ["session-cookie-export", /"(?:sb-[a-z0-9-]+-auth-token|refresh_token)"\s*:\s*"[A-Za-z0-9._-]{20,}"/],
  ["ssh-password-literal", /(?:ssh[_-]?pass(?:word)?|sshpass)\s*[=:]\s*["'][^"'\s]{4,}["']/i],
  ["db-password-literal", /(?:db[_-]?pass(?:word)?|pgpassword)\s*[=:]\s*["'][^"'\s]{4,}["']/i],
];

/**
 * Placeholder-looking values that must not be reported as real. Includes the
 * marker the 2026-08-03 history rewrite substituted for scrubbed credentials:
 * it records the ABSENCE of a secret, so flagging it would be backwards.
 */
const PLACEHOLDER =
  /^(?:<[^>]+>|\[[^\]]+\]|\$\{?[A-Z_]+\}?|YOUR[_-]?\w*|EXAMPLE\w*|CHANGE_?ME|REDACTED|X{3,}|\*{3,}|password|PASSWORD|secret|SECRET|test|TEST|\*{3}REMOVED-SENSITIVE-VALUE\*{3})$/;

/**
 * A DSN counts only when the password position holds a literal.
 *
 * Two exclusions, both learned from real false positives in this repository: a
 * shell/JS interpolation (`$env:X`, `${x}`, `%X%`) is a reference rather than a
 * value, and a DSN-parsing regex contains character classes that look like a
 * DSN without being one. Reporting either would train people to ignore the
 * scanner, which is worse than not having it.
 */
function realDsn(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const looksLikeRegexSource =
      /\[\^|\\s|\(\?:|matchAll|new RegExp|-match|-replace/.test(line);
    if (looksLikeRegexSource) continue;
    for (const m of line.matchAll(/postgres(?:ql)?:\/\/[^\s:@/"']+:([^\s@/"']+)@/g)) {
      const secret = m[1];
      if (PLACEHOLDER.test(secret)) continue;
      if (/[$%{}()]/.test(secret)) continue;
      return true;
    }
  }
  return false;
}

/** Credential-shaped column in a delimited header. */
const CREDENTIAL_COLUMN =
  /(^|[,\t;|"])\s*"?(password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|service[_-]?role)"?\s*($|[,\t;|"])/i;

/**
 * A bulk personal-data export: many rows that pair an identity column with a
 * person-shaped value. Threshold 20 so a small synthetic fixture stays legal.
 */
function bulkPersonalExport(file, text) {
  if (!/\.(tsv|csv|psv)$/i.test(file)) return false;
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 20) return false;
  const header = lines[0].toLowerCase();
  const hasIdentity = /(^|[,\t;])\s*"?(name|full_?name|employee_?name)"?\s*($|[,\t;])/.test(header);
  const hasKey = /(^|[,\t;])\s*"?(employee_?id|email|user_?id)"?\s*($|[,\t;])/.test(header);
  return hasIdentity && hasKey;
}

function listFiles() {
  const args = STAGED_ONLY
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["ls-files"];
  return execFileSync("git", args, { encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function main() {
  const findings = [];
  const seen = (category, file) => findings.push({ category, file });

  for (const file of listFiles()) {
    const normalized = file.split(path.sep).join("/");

    if (FORBIDDEN_PATHS.includes(normalized)) seen("forbidden-path", normalized);
    if (FORBIDDEN_PREFIX.some((p) => normalized.startsWith(p))) {
      seen("tracked-local-sensitive-path", normalized);
    }
    if (SKIP_PREFIX.some((p) => normalized.startsWith(p))) continue;
    if (SELF.includes(normalized)) continue;
    if (RISKY_EXT.test(normalized)) seen("risky-file-type", normalized);
    if (!fs.existsSync(file)) continue;

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;

    let text;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    // Binary: a NUL byte means the UTF-8 read produced garbage, not source.
    if (text.includes("\u0000")) continue;

    for (const [category, rx] of CONTENT_RULES) {
      if (rx.test(text)) seen(category, normalized);
    }
    if (realDsn(text)) seen("dsn-with-credentials", normalized);

    if (/\.(tsv|csv|psv)$/i.test(normalized)) {
      const header = text.split("\n", 1)[0] ?? "";
      if (CREDENTIAL_COLUMN.test(header)) seen("credential-column", normalized);
    }
    if (bulkPersonalExport(normalized, text)) seen("bulk-personal-export", normalized);
  }

  if (findings.length === 0) {
    console.log(`security:secrets — clean (${STAGED_ONLY ? "staged" : "tracked"} files)`);
    process.exit(0);
  }

  console.error(`\nsecurity:secrets — ${findings.length} finding(s):\n`);
  for (const f of findings) console.error(`  [${f.category}] ${f.file}`);
  console.error(
    "\nNo value is printed by design. See Documentations MD/sensitive-local-data-policy.md.\n" +
      "Never use `git add -f` to bypass this.\n",
  );
  process.exit(1);
}

main();
