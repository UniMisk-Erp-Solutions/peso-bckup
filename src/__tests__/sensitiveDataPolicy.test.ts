/**
 * The sensitive-data policy must stay installed and internally consistent.
 *
 * A policy that lives only in prose gets edited away by a later refactor that
 * "tidied the docs". These tests make removal a visible failure, and they check
 * the parts that can silently drift: that CLAUDE.md still carries the rule, that
 * the command it names actually exists, that the ignore rules cover the paths the
 * documentation promises, and that the synthetic template stayed synthetic.
 *
 * No sensitive value appears here.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf-8");

const CLAUDE = "CLAUDE.md";
const POLICY = "Documentations MD/sensitive-local-data-policy.md";
const CLONE_DOC = "Documentations MD/post-history-rewrite-clone-instructions.md";
const SCANNER = "scripts/security/check-sensitive-files.mjs";
const TEMPLATE = "scripts/data/examples/employee-operation.example.tsv";
const LOADER = "scripts/lib/employeeDataInput.mjs";

/** The file this whole policy exists because of. */
const REMOVED_TSV = "scripts/data/microlink-remove-employees.tsv";

describe("CLAUDE.md carries the non-negotiable rule", () => {
  it("has the required heading", () => {
    expect(read(CLAUDE)).toContain("## Sensitive Data and Git Safety — Non-Negotiable");
  });

  it("documents the canonical ignored directory", () => {
    expect(read(CLAUDE)).toContain(".local-sensitive-data/");
  });

  it("names the secret-check command, and that command exists", () => {
    const claude = read(CLAUDE);
    expect(claude).toContain("npm run security:secrets");

    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["security:secrets"]).toBeTruthy();
    expect(existsSync(resolve(process.cwd(), SCANNER))).toBe(true);
  });

  it("forbids literal secret fallbacks and `git add -f`", () => {
    const claude = read(CLAUDE);
    expect(claude).toMatch(/git add -f/);
    expect(claude).toMatch(/fail loudly/i);
  });

  it("mentions the removed file only as absent, never as a source to restore", () => {
    const claude = read(CLAUDE);
    // The prohibition wording must be present...
    expect(claude).toMatch(/intentionally absent from this repository/i);
    // ...and CLAUDE.md must not carry the path as a usable default.
    expect(claude).not.toContain(REMOVED_TSV);
  });

  it("contains no credential-shaped value of its own", () => {
    const claude = read(CLAUDE);
    expect(claude).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(claude).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    // A DSN whose password position is a real literal, not a placeholder.
    expect(claude).not.toMatch(/postgres(?:ql)?:\/\/[^\s:@/"']+:(?!<|\$|\[)[^\s@/"']{6,}@/);
  });
});

describe("policy documentation is present and consistent", () => {
  it("both documents exist", () => {
    expect(existsSync(resolve(process.cwd(), POLICY))).toBe(true);
    expect(existsSync(resolve(process.cwd(), CLONE_DOC))).toBe(true);
  });

  it("the policy names the same ignored directory as CLAUDE.md", () => {
    expect(read(POLICY)).toContain(".local-sensitive-data/");
  });

  it("the policy names the same scanner command as CLAUDE.md", () => {
    expect(read(POLICY)).toContain("npm run security:secrets");
  });

  it("the policy carries the do-not-reconstruct warning", () => {
    expect(read(POLICY)).toMatch(/[Dd]o not reconstruct it from Git history/);
  });

  it("the policy labels the account risk as owner-accepted, not resolved", () => {
    const policy = read(POLICY);
    expect(policy).toContain("OWNER-ACCEPTED RESIDUAL ACCOUNT RISK");
    // The honest claim: cleanup cannot prove the accounts are safe.
    expect(policy).toMatch(/cannot prove/i);
  });

  it("the clone instructions forbid pushing from an old clone", () => {
    expect(read(CLONE_DOC)).toMatch(/never push an old clone/i);
  });
});

describe(".gitignore covers the documented local paths", () => {
  const ignored = (p: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", p], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it("ignores the canonical local directory", () => {
    expect(ignored(".local-sensitive-data/anything.tsv")).toBe(true);
  });

  it("ignores the private and local script data directories", () => {
    expect(ignored("scripts/data/private/x.tsv")).toBe(true);
    expect(ignored("scripts/data/local/x.tsv")).toBe(true);
  });

  it("ignores marked private and export files anywhere", () => {
    expect(ignored("anywhere/thing.private.tsv")).toBe(true);
    expect(ignored("anywhere/thing.employee-export.csv")).toBe(true);
    expect(ignored("capture.har")).toBe(true);
  });

  it("does NOT ignore the synthetic template or the security docs", () => {
    // Over-broad ignore rules are their own failure: they hide legitimate files.
    expect(ignored(TEMPLATE)).toBe(false);
    expect(ignored(POLICY)).toBe(false);
    expect(ignored("src/components/Anything.tsx")).toBe(false);
  });
});

describe("the synthetic template stays synthetic", () => {
  it("exists and declares no password column", () => {
    const header = read(TEMPLATE).split("\n")[0].toLowerCase();
    expect(header).toContain("employee_id");
    expect(header).not.toMatch(/\bpassword\b|\bsecret\b|\btoken\b/);
  });

  it("uses obviously fake employee IDs", () => {
    const rows = read(TEMPLATE).split("\n").slice(1).filter(Boolean);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.split("\t")[1]).toMatch(/^EX-/);
    }
  });

  it("contains no email, UUID or organization ID", () => {
    const text = read(TEMPLATE);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("stays small enough to be a template rather than a dataset", () => {
    expect(read(TEMPLATE).split("\n").filter(Boolean).length).toBeLessThan(20);
  });
});

describe("the removed data and its unsafe tooling stay removed", () => {
  const tracked = new Set(
    execFileSync("git", ["ls-files"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .map((s) => s.trim()),
  );

  it.each([
    REMOVED_TSV,
    "scripts/data/microlink-supervisor-emails.json",
    "scripts/data/microlink-bulk-import.csv",
    "scripts/sync-microlink-passwords.mjs",
    "scripts/sync-microlink-passwords-service.mjs",
    "scripts/reset-microlink-employee-passwords.sql",
    ".env",
  ])("%s is not tracked", (path) => {
    expect(tracked.has(path)).toBe(false);
  });

  it("no generator hardcodes a default path into repository data", () => {
    for (const script of [
      "scripts/generate-link-microlink-supervisors-sql.mjs",
      "scripts/generate-microlink-import-csv.mjs",
      "scripts/generate-remove-org-employees-sql.mjs",
    ]) {
      const src = read(script);
      expect(src).not.toContain(REMOVED_TSV);
      // Input must come from the shared loader, never a literal path.
      expect(src).toContain("employeeDataInput.mjs");
    }
  });

  it("the loader rejects credential columns and has no default path", () => {
    const src = read(LOADER);
    for (const column of ["password", "secret", "token", "private_key", "service_role"]) {
      expect(src).toContain(`"${column}"`);
    }
    expect(src).toMatch(/No input file/);
  });
});
