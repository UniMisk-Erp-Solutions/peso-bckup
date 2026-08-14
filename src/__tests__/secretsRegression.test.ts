/**
 * Secret-regression guard.
 *
 * An SSH password sat in tracked scripts from 2026-07-07 until the 2026-08-02
 * audit found it, because the pattern was
 *
 *     PASSWORD = os.environ.get("COOLIFY_SSH_PASSWORD", "<literal>")
 *
 * — an environment variable with a working literal fallback. Nothing failed when
 * the variable was unset, so nothing drew attention to it. These tests fail the
 * build if a credential literal reappears.
 *
 * The known password is deliberately NOT written here. Reproducing it in a test
 * would put it straight back into the repository, which is the defect. The
 * checks are structural instead: they detect the SHAPE of a hardcoded secret.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const cwd = process.cwd();

/** Tracked files only — untracked scratch files are not shipped. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
}

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|sh|sql|json|md|yml|yaml|toml|env|example|txt)$/i;

/** This file necessarily contains the very patterns it hunts for. */
/**
 * Files that legitimately QUOTE a forbidden pattern in order to prohibit it.
 * Flagging the policy that bans literal fallbacks would be the guard reporting
 * its own documentation, which is how guards get deleted.
 */
const SELF_EXCLUDED = new Set([
  "src/__tests__/secretsRegression.test.ts",
  "src/__tests__/sensitiveDataPolicy.test.ts",
  "src/__tests__/credentialDataFiles.test.ts",
  "scripts/security/check-sensitive-files.mjs",
  "CLAUDE.md",
  "Documentations MD/sensitive-local-data-policy.md",
]);
const SELF = "src/__tests__/secretsRegression.test.ts";

function readTracked(): { path: string; body: string }[] {
  return trackedFiles()
    .filter((f) => TEXT_EXT.test(f) && !SELF_EXCLUDED.has(f))
    .map((path) => {
      try {
        return { path, body: readFileSync(resolve(cwd, path), "utf-8") };
      } catch {
        return { path, body: "" };
      }
    });
}

describe("no hardcoded credentials in tracked files", () => {
  const files = readTracked();

  it("has no literal password fallback in an env lookup", () => {
    // os.environ.get("X_PASSWORD", "literal")  /  process.env.X || "literal"
    const py = /environ\.get\(\s*["'][A-Z0-9_]*(PASSWORD|SECRET|TOKEN|KEY)["']\s*,\s*["'][^"']{6,}["']\s*\)/;
    const js = /process\.env\.[A-Z0-9_]*(PASSWORD|SECRET|TOKEN)\s*(\|\||\?\?)\s*["'][^"']{6,}["']/;
    const offenders = files.filter((f) => py.test(f.body) || js.test(f.body));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("has no password-like assignment in SSH or deployment scripts", () => {
    const scripts = files.filter(
      (f) => /^scripts\//.test(f.path) && /(ssh|deploy|remote|coolify)/i.test(f.path),
    );
    expect(scripts.length).toBeGreaterThan(0);
    // PASSWORD = "..." / PW = '...' / password: "..." with a real-looking value.
    const assign =
      /\b(PASSWORD|PASSWD|PW|SSH_PASS|DB_PASSWORD|password)\b\s*[:=]\s*["'][^"'\s]{6,}["']/;
    const offenders = scripts.filter((f) => {
      for (const line of f.body.split("\n")) {
        if (!assign.test(line)) continue;
        // Reading from the environment or the shared loader is the fix, not a hit.
        if (/environ|process\.env|getenv|load_ssh_credentials|_CREDS|getpass/.test(line)) continue;
        return true;
      }
      return false;
    });
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("contains no private key material", () => {
    const key = /-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/;
    // This test file names the marker itself, so exclude it.
    const offenders = files.filter((f) => key.test(f.body) && !f.path.endsWith(__filename.split(/[\\/]/).pop()!));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("contains no Supabase service-role JWT", () => {
    // service_role JWTs are long three-part tokens beginning eyJ.
    const jwt = /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/;
    const offenders = files.filter((f) => jwt.test(f.body));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it("contains no postgres connection string with a real inline password", () => {
    // Template DSNs are fine and are how the docs explain the format. What must
    // never appear is a literal that actually authenticates.
    const dsn = /postgres(ql)?:\/\/[^\s:@/]+:([^\s@/'"`]+)@/g;
    // `***REMOVED-SENSITIVE-VALUE***` is the marker the 2026-08-03 history
    // rewrite substituted for scrubbed credentials. It is the ABSENCE of a
    // secret, so treating it as one would make the guard permanently red.
    const placeholder =
      /^(\$\{.*\}|<[^>]*>|\[[^\]]*\]|%[A-Z_]+%|\$[A-Za-z_]\w*|password|PASSWORD|pass|secret|SECRET|changeme|CHANGEME|your[-_]?password|YOUR[-_]?PASSWORD|postgres|user|username|example|xxx+|\.\.\.|\*{3}REMOVED-SENSITIVE-VALUE\*{3})$/i;
    const offenders: string[] = [];
    for (const f of files) {
      for (const m of f.body.matchAll(dsn)) {
        const secret = m[2];
        if (!placeholder.test(secret)) {
          offenders.push(`${f.path} (len ${secret.length})`);
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps .env out of version control", () => {
    const tracked = trackedFiles();
    expect(tracked.filter((f) => /(^|\/)\.env$/.test(f))).toEqual([]);
    const ignore = readFileSync(resolve(cwd, ".gitignore"), "utf-8");
    expect(ignore).toMatch(/^\.env$/m);
  });
});

describe("shared SSH credential loader", () => {
  const loader = readFileSync(resolve(cwd, "scripts/_ssh_credentials.py"), "utf-8");

  it("offers no built-in password default", () => {
    expect(loader).toMatch(/MissingCredentialError/);
    // The env lookups must have no second (default) argument.
    expect(loader).not.toMatch(/environ\.get\(\s*[A-Z_]+\s*,\s*["']/);
  });

  it("fails loudly when nothing is configured", () => {
    expect(loader).toMatch(/raise MissingCredentialError/);
    expect(loader).toMatch(/There is deliberately no built-in password/);
  });

  it("never renders the secret via repr or str", () => {
    expect(loader).toMatch(/__repr__/);
    expect(loader).toMatch(/__str__ = __repr__/);
    expect(loader).toMatch(/repr=False/);
  });

  it("cleans up temp key material on every path", () => {
    expect(loader).toMatch(/def cleanup_temp_files/);
    expect(loader).toMatch(/finally:\s*\n\s*cleanup_temp_files\(\)/);
    expect(loader).toMatch(/contextlib\.suppress\(OSError\)/);
  });

  it("prefers keys and only prompts on a TTY", () => {
    expect(loader).toMatch(/key_filename=creds\.key_path/);
    expect(loader).toMatch(/sys\.stdin\.isatty\(\)/);
  });

  it("is actually used by every SSH script that needs a credential", () => {
    const scripts = trackedFiles().filter(
      (f) => /^scripts\/.*\.py$/.test(f) && /(ssh|deploy|remote|coolify)/i.test(f),
    );
    const needing = scripts.filter((f) => {
      const body = readFileSync(resolve(cwd, f), "utf-8");
      return /paramiko|\bPASSWORD\b|\bPW\b/.test(body);
    });
    expect(needing.length).toBeGreaterThan(0);
    const missing = needing.filter((f) => {
      const body = readFileSync(resolve(cwd, f), "utf-8");
      return !/load_ssh_credentials/.test(body);
    });
    expect(missing).toEqual([]);
  });
});
