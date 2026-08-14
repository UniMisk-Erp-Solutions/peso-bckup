/**
 * DOC-090 — source guards for the source-map build script.
 *
 * The install/upload IO cannot run in a unit test (it downloads a Linux binary
 * and uploads to a live server), so these assert the script's SHAPE encodes the
 * required behaviour: fail-closed on a credentialed failure, skip on missing
 * credentials, token never logged or passed as an argument, binary never
 * committed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";

const ROOT = process.cwd();
const script = readFileSync(resolve(ROOT, "scripts/glitchtip-sourcemaps.mjs"), "utf-8");
const lib = readFileSync(resolve(ROOT, "scripts/lib/glitchtipCli.mjs"), "utf-8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const scriptCode = stripComments(script);

describe("fail-closed when credentials are present (§9)", () => {
  it("has a fail() that exits non-zero", () => {
    expect(scriptCode).toMatch(/function fail\([^)]*\)\s*\{[\s\S]*?process\.exit\(1\)/);
  });

  it("fails on install, inject and upload errors", () => {
    expect(scriptCode).toMatch(/could not obtain glitchtip-cli/);
    expect(scriptCode).toMatch(/fail\("debug-ID injection failed\."\)/);
    expect(scriptCode).toMatch(/fail\("source-map upload failed\."\)/);
  });

  it("verifies the CLI actually executes before relying on it (E)", () => {
    expect(scriptCode).toMatch(/does not execute on this platform/);
  });

  it("prunes maps ONLY after a successful upload, never on a failed one", () => {
    const uploadIdx = scriptCode.indexOf("upload complete.");
    const pruneIdx = scriptCode.indexOf('pruneMaps("uploaded to GlitchTip")');
    expect(uploadIdx).toBeGreaterThan(-1);
    expect(pruneIdx).toBeGreaterThan(uploadIdx);
  });
});

describe("skip (never fail) when credentials are missing (§8)", () => {
  it("skips and prunes without installing anything", () => {
    expect(scriptCode).toMatch(/SKIPPING upload — missing build-only env/);
    expect(scriptCode).toMatch(/pruneMaps\("no upload credentials"\)/);
  });

  it("the missing-credentials branch returns before the CLI is resolved", () => {
    const skipIdx = scriptCode.indexOf("SKIPPING upload");
    // The call site (not the function definition) is only reached after the
    // missing-credentials early return.
    const callIdx = scriptCode.indexOf("await resolveCli()");
    expect(skipIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(skipIdx);
  });

  it("an unexpected error without credentials degrades to skip, not failure", () => {
    expect(scriptCode).toMatch(/missingCredentials\(process\.env\)\.length > 0/);
    expect(scriptCode).toMatch(/skipping upload after a non-fatal error/);
  });
});

describe("reproducible, PATH-independent CLI (§5, §6)", () => {
  it("no longer instructs the user to install the CLI by hand and give up", () => {
    expect(script).not.toMatch(/curl -fsSL https:\/\/glitchtip\.com\/install\.sh \| sh/);
    expect(scriptCode).not.toMatch(/not found on PATH/);
  });

  it("installs into a gitignored project-local cache, called by absolute path", () => {
    expect(scriptCode).toMatch(/node_modules\/\.cache\/glitchtip/);
    expect(scriptCode).toMatch(/CACHE_BIN/);
  });

  it("pins a version and verifies a checksum", () => {
    expect(scriptCode).toMatch(/checksumMatches\(/);
    expect(lib).toMatch(/CLI_VERSION\s*=\s*"v\d+\.\d+\.\d+"/);
    expect(lib).toMatch(/CLI_SHA256/);
  });
});

describe("token safety (§11)", () => {
  it("never logs the token", () => {
    expect(scriptCode).not.toMatch(/console\.log[^\n]*SENTRY_AUTH_TOKEN/);
    expect(scriptCode).not.toMatch(/log\([^)]*SENTRY_AUTH_TOKEN/);
  });

  it("passes the token via the child environment, not as an argv element", () => {
    // The token must never appear in a CLI arguments array.
    expect(scriptCode).not.toMatch(/--auth-token/);
    expect(scriptCode).not.toMatch(/SENTRY_AUTH_TOKEN[^\n]*\]/);
    expect(scriptCode).toMatch(/env: process\.env/);
  });

  it("no SENTRY_AUTH_TOKEN or VITE_-prefixed upload secret anywhere in the pipeline", () => {
    const combined = stripComments(script) + "\n" + stripComments(lib);
    // The lib references the var names for the *missing* check only; the token
    // value is never embedded, and nothing is VITE_-prefixed.
    expect(combined).not.toMatch(/VITE_[A-Z_]*(AUTH|TOKEN|SECRET)/);
  });
});

describe("no CLI binary is tracked by git (§12 J)", () => {
  it("git does not track any glitchtip-cli binary", () => {
    const tracked = execSync("git ls-files", { cwd: ROOT }).toString();
    expect(tracked).not.toMatch(/glitchtip-cli(\.exe)?$/m);
    expect(tracked).not.toMatch(/node_modules\/\.cache/);
  });

  it("the cache path resolves under gitignored node_modules", () => {
    // node_modules is ignored wholesale, so the cached binary can never be added.
    let ignored = "";
    try {
      ignored = execSync("git check-ignore node_modules/.cache/glitchtip/glitchtip-cli", {
        cwd: ROOT,
      }).toString();
    } catch {
      ignored = "";
    }
    expect(ignored.trim()).toMatch(/node_modules[\\/]\.cache[\\/]glitchtip/);
  });
});
