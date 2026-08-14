/**
 * DOC-090 — pure helpers for resolving the GlitchTip CLI in a build.
 *
 * No side effects: every function here takes its inputs as arguments and
 * returns a decision, so the install logic is unit-testable without touching
 * the network, the filesystem or a child process. The IO wrapper
 * (scripts/glitchtip-sourcemaps.mjs) turns these decisions into actions.
 *
 * Why a pinned direct binary rather than `curl install.sh | sh`:
 *  - The official install script has NO version pinning and writes to
 *    /usr/local/bin, whose presence on PATH does not survive reliably between
 *    Vercel build phases. That is exactly why the previous build failed with
 *    "glitchtip-cli not found on PATH".
 *  - GlitchTip publishes per-version raw binaries on GitLab. Pinning v1.0.0 and
 *    verifying its SHA-256 gives a reproducible, supply-chain-checked install
 *    that we drop into a project-local cache and call by absolute path.
 */

/** Pinned release. Bump deliberately, together with the checksum below. */
export const CLI_VERSION = "v1.0.0";

/**
 * SHA-256 of each pinned release asset, verified after download.
 *
 * Only linux-x86_64 is pinned because that is the only platform a Vercel build
 * runs on. Local developers on macOS/Windows use a CLI already on PATH (or skip
 * upload entirely); the build never downloads for them.
 */
export const CLI_SHA256 = {
  "linux-x86_64": "de1c035aa61931a6265d7b29b1614781dfee925466142a907508cb097082dfef",
};

/** Map Node's process.platform/arch to the GlitchTip asset suffix. */
export function assetName(platform, arch) {
  const p =
    platform === "linux" ? "linux" : platform === "darwin" ? "macos" : platform === "win32" ? "windows" : null;
  const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "arm64" : null;
  if (!p || !a) return null;
  if (p === "windows") return `glitchtip-cli-windows-${a}.exe`;
  return `glitchtip-cli-${p}-${a}`;
}

/** Short key used to look up the pinned checksum, e.g. "linux-x86_64". */
export function platformKey(platform, arch) {
  const name = assetName(platform, arch);
  if (!name) return null;
  return name.replace(/^glitchtip-cli-/, "").replace(/\.exe$/, "");
}

/** Direct, version-pinned download URL for a GitLab CI artifact binary. */
export function assetUrl(platform, arch, version = CLI_VERSION) {
  const name = assetName(platform, arch);
  if (!name) return null;
  const jobSuffix = name.replace(/^glitchtip-cli-/, "").replace(/\.exe$/, "");
  const job = `build-${jobSuffix}`;
  return `https://gitlab.com/glitchtip/glitchtip-cli/-/jobs/artifacts/${version}/raw/artifacts/${name}?job=${job}`;
}

/** Expected SHA-256 for the current platform, or null if unpinned. */
export function expectedSha256(platform, arch) {
  const key = platformKey(platform, arch);
  return (key && CLI_SHA256[key]) || null;
}

/**
 * Decide how to obtain the CLI. Pure — the caller performs the resulting action.
 *
 * Precedence:
 *   1. a CLI already on PATH (developer machine, or a base image that has it),
 *   2. a previously cached download from an earlier build phase,
 *   3. a fresh pinned download, but only on a platform we have a checksum for.
 *
 * On an unsupported/unpinned platform with credentials present, the caller must
 * fail the build (§9) rather than deploy claiming source maps are configured.
 */
export function planCliResolution({ cliOnPath, cachedExists, platform, arch }) {
  if (cliOnPath) return { action: "use-path" };
  if (cachedExists) return { action: "use-cache" };

  const url = assetUrl(platform, arch);
  const sha256 = expectedSha256(platform, arch);
  if (!url || !sha256) {
    return {
      action: "unsupported",
      reason: `no pinned GlitchTip CLI for ${platform}/${arch}`,
    };
  }
  return { action: "download", url, sha256, version: CLI_VERSION };
}

/** Constant-time-ish checksum comparison (case-insensitive hex). */
export function checksumMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  return a.length === e.length && a === e;
}

/** Which SENTRY_* upload vars are missing from a given env map. */
export function missingCredentials(env) {
  return ["SENTRY_URL", "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"].filter(
    (k) => !env[k],
  );
}
