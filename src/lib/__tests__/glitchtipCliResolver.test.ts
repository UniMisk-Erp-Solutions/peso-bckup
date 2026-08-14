/**
 * DOC-090 — GlitchTip CLI resolution logic.
 *
 * These test the pure planner in scripts/lib/glitchtipCli.mjs that decides how
 * the build obtains the CLI. They cover the branches the reproducible-install
 * fix introduced (A–J in the task), without hitting the network or spawning a
 * process. The real credentialed upload is proven on Vercel after push.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs build helper, no type declarations by design.
import {
  CLI_VERSION,
  CLI_SHA256,
  assetName,
  assetUrl,
  expectedSha256,
  platformKey,
  planCliResolution,
  checksumMatches,
  missingCredentials,
} from "../../../scripts/lib/glitchtipCli.mjs";

describe("asset resolution", () => {
  it("pins a real version", () => {
    expect(CLI_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("maps the Vercel build platform (linux/x64) to the right asset", () => {
    expect(assetName("linux", "x64")).toBe("glitchtip-cli-linux-x86_64");
    expect(platformKey("linux", "x64")).toBe("linux-x86_64");
  });

  it.each([
    ["darwin", "arm64", "glitchtip-cli-macos-arm64"],
    ["win32", "x64", "glitchtip-cli-windows-x86_64.exe"],
    ["linux", "arm64", "glitchtip-cli-linux-arm64"],
  ])("maps %s/%s", (p, a, expected) => {
    expect(assetName(p, a)).toBe(expected);
  });

  it("returns null for an unknown platform/arch", () => {
    expect(assetName("sunos", "mips")).toBeNull();
    expect(assetUrl("sunos", "mips")).toBeNull();
  });

  it("builds a version-pinned GitLab artifact URL", () => {
    const url = assetUrl("linux", "x64");
    expect(url).toContain(`/jobs/artifacts/${CLI_VERSION}/raw/artifacts/glitchtip-cli-linux-x86_64`);
    expect(url).toContain("job=build-linux-x86_64");
  });

  it("pins a checksum for the Vercel platform", () => {
    const sha = expectedSha256("linux", "x64");
    expect(sha).toBe(CLI_SHA256["linux-x86_64"]);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("planCliResolution", () => {
  const base = { platform: "linux", arch: "x64" };

  it("A. uses a CLI already on PATH without downloading", () => {
    expect(planCliResolution({ ...base, cliOnPath: true, cachedExists: false })).toEqual({
      action: "use-path",
    });
  });

  it("uses a cached binary from an earlier phase before downloading", () => {
    expect(planCliResolution({ ...base, cliOnPath: false, cachedExists: true })).toEqual({
      action: "use-cache",
    });
  });

  it("C. plans a pinned, checksummed download when absent on a supported platform", () => {
    const plan = planCliResolution({ ...base, cliOnPath: false, cachedExists: false });
    expect(plan.action).toBe("download");
    expect(plan.url).toContain("glitchtip-cli-linux-x86_64");
    expect(plan.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.version).toBe(CLI_VERSION);
  });

  it("refuses to download on an unpinned platform (build must fail closed)", () => {
    const plan = planCliResolution({
      platform: "sunos",
      arch: "mips",
      cliOnPath: false,
      cachedExists: false,
    });
    expect(plan.action).toBe("unsupported");
  });
});

describe("checksum verification", () => {
  it("accepts an exact match, case-insensitively", () => {
    expect(checksumMatches("ABCDEF", "abcdef")).toBe(true);
  });
  it("rejects a mismatch (D. installer produced the wrong bytes)", () => {
    expect(checksumMatches("abcdef", "abcde0")).toBe(false);
    expect(checksumMatches("", CLI_SHA256["linux-x86_64"])).toBe(false);
  });
});

describe("missingCredentials", () => {
  it("B. reports all four missing on an empty env", () => {
    expect(missingCredentials({})).toEqual([
      "SENTRY_URL",
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
    ]);
  });

  it("reports none when all four are present", () => {
    expect(
      missingCredentials({
        SENTRY_URL: "x",
        SENTRY_AUTH_TOKEN: "x",
        SENTRY_ORG: "x",
        SENTRY_PROJECT: "x",
      }),
    ).toEqual([]);
  });

  it("reports only the token when the rest are set", () => {
    expect(
      missingCredentials({ SENTRY_URL: "x", SENTRY_ORG: "x", SENTRY_PROJECT: "x" }),
    ).toEqual(["SENTRY_AUTH_TOKEN"]);
  });
});
