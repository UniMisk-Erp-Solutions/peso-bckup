#!/usr/bin/env node
/**
 * DOC-090 — GlitchTip source-map pipeline.
 *
 * Wraps the official GlitchTip CLI (https://glitchtip.com/documentation/cli/):
 *
 *   glitchtip-cli sourcemaps inject ./dist
 *   glitchtip-cli sourcemaps upload ./dist --release <sha> --org <org> --project <proj>
 *
 * Debug IDs are injected into the built JS and its .map files, so GlitchTip
 * matches an incoming stack frame to the right source map without depending on
 * a publicly served //# sourceMappingURL — which vite's `sourcemap: "hidden"`
 * deliberately omits.
 *
 * REPRODUCIBLE CLI (fixes the previous Vercel failure)
 *   The previous build failed with "glitchtip-cli not found on PATH": the CLI
 *   was only ever installed by hand on a developer machine, and Vercel's build
 *   image does not have it. This script now installs it itself, pinned to
 *   CLI_VERSION and verified by SHA-256, into a gitignored project-local cache,
 *   and calls it by absolute path — no dependency on a preinstalled global CLI
 *   or on PATH surviving between build phases.
 *
 * SAFETY PROPERTIES
 *  - Credentials come from build-only env (SENTRY_URL / SENTRY_AUTH_TOKEN /
 *    SENTRY_ORG / SENTRY_PROJECT), none VITE_-prefixed, none reachable by the
 *    browser. The token is passed only through the child process environment,
 *    never as an argument, a URL, or a log line.
 *  - Missing credentials → SKIP + prune maps + exit 0. Contributor and preview
 *    builds without a token must keep working, and must NOT install anything.
 *  - Credentials PRESENT but any step fails (install / auth / inject / upload)
 *    → FAIL the build (exit 1). A configured monitored deployment must never
 *    ship silently claiming source maps are set up when they are not.
 *  - .map files are pruned in every non-failing path, so the original sources
 *    are never deployed publicly, whether or not upload ran.
 *
 * Usage:
 *   node scripts/glitchtip-sourcemaps.mjs            # resolve CLI + inject + upload + prune
 *   node scripts/glitchtip-sourcemaps.mjs --keep-maps
 *   node scripts/glitchtip-sourcemaps.mjs --dry-run
 */

import { execFileSync, execSync } from "node:child_process";
import { readdirSync, statSync, rmSync, existsSync, mkdirSync, createWriteStream, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CLI_VERSION,
  missingCredentials,
  planCliResolution,
  checksumMatches,
} from "./lib/glitchtipCli.mjs";

const DIST = resolve(process.cwd(), "dist");
const CACHE_DIR = resolve(process.cwd(), "node_modules/.cache/glitchtip");
const CACHE_BIN = join(CACHE_DIR, process.platform === "win32" ? "glitchtip-cli.exe" : "glitchtip-cli");

const args = new Set(process.argv.slice(2));
const KEEP_MAPS = args.has("--keep-maps");
const DRY_RUN = args.has("--dry-run");

function log(msg) {
  console.log(`[glitchtip-sourcemaps] ${msg}`);
}

/** Fail the build. Only ever called once credentials prove this is a monitored deploy. */
function fail(msg) {
  log(`ERROR: ${msg}`);
  log("Credentials are configured, so this is a monitored deployment and the build must fail.");
  process.exit(1);
}

function listMaps(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listMaps(full));
    else if (entry.endsWith(".map")) out.push(full);
  }
  return out;
}

function resolveRelease() {
  if (process.env.APP_RELEASE) return process.env.APP_RELEASE;
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

/** A `glitchtip-cli` already on PATH? (developer machines, some base images.) */
function cliOnPath() {
  try {
    execFileSync("glitchtip-cli", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Download a URL to a file, following redirects, without printing anything sensitive. */
async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (HTTP ${res.status})`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const { Readable } = await import("node:stream");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/**
 * Return an absolute path to a runnable CLI, installing it if necessary.
 * Throws on any failure; the caller decides whether that fails the build.
 */
async function resolveCli() {
  const plan = planCliResolution({
    cliOnPath: cliOnPath(),
    cachedExists: existsSync(CACHE_BIN),
    platform: process.platform,
    arch: process.arch,
  });

  if (plan.action === "use-path") {
    log("using glitchtip-cli found on PATH.");
    return "glitchtip-cli";
  }
  if (plan.action === "use-cache") {
    log(`using cached glitchtip-cli (${CACHE_BIN}).`);
    return CACHE_BIN;
  }
  if (plan.action === "unsupported") {
    throw new Error(`${plan.reason}; cannot install a pinned CLI for this build platform`);
  }

  // Fresh pinned download.
  log(`installing glitchtip-cli ${plan.version} (pinned, checksum-verified)…`);
  await download(plan.url, CACHE_BIN);
  const actual = await sha256File(CACHE_BIN);
  if (!checksumMatches(actual, plan.sha256)) {
    rmSync(CACHE_BIN, { force: true });
    throw new Error(
      `checksum mismatch for downloaded CLI (expected ${plan.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
    );
  }
  chmodSync(CACHE_BIN, 0o755);
  log("glitchtip-cli installed and checksum verified.");
  return CACHE_BIN;
}

function pruneMaps(reason) {
  if (KEEP_MAPS) {
    log(`--keep-maps set: leaving .map files in dist/ (${reason}).`);
    return;
  }
  let removed = 0;
  for (const m of listMaps(DIST)) {
    rmSync(m);
    removed += 1;
  }
  log(`removed ${removed} .map file(s) from dist/ — original sources are not deployed (${reason}).`);
}

/** Run the CLI, passing the auth token only via the child environment. */
function runCli(bin, cliArgs) {
  execFileSync(bin, cliArgs, {
    stdio: "inherit",
    env: process.env, // SENTRY_AUTH_TOKEN flows here, never as an argv element
  });
}

async function main() {
  if (!existsSync(DIST)) {
    log("dist/ not found — run `npm run build` first. Skipping.");
    return;
  }

  const maps = listMaps(DIST);
  log(`found ${maps.length} source map(s) in dist/`);
  if (maps.length === 0) {
    log("nothing to upload (is build.sourcemap enabled?). Skipping.");
    return;
  }

  const missing = missingCredentials(process.env);
  if (missing.length > 0) {
    // Not an error, and — importantly — no install is attempted. A contributor
    // build without a token must stay fast and offline.
    log(`SKIPPING upload — missing build-only env: ${missing.join(", ")}`);
    log("Source maps were generated but NOT uploaded. Stacks will stay minified.");
    pruneMaps("no upload credentials");
    return;
  }

  // From here on, this is a configured monitored deployment: every failure is fatal.
  const release = resolveRelease();
  if (!release) fail("could not resolve a release identifier (set APP_RELEASE).");

  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;

  if (DRY_RUN) {
    log(`DRY RUN — pinned CLI ${CLI_VERSION}; would inject debug IDs into ${DIST}`);
    log(`DRY RUN — would upload with --release ${release} --org ${org} --project ${project}`);
    return;
  }

  let bin;
  try {
    bin = await resolveCli();
  } catch (e) {
    fail(`could not obtain glitchtip-cli — ${e.message}`);
  }

  // Prove the binary runs before relying on it.
  try {
    runCli(bin, ["--version"]);
  } catch {
    fail("glitchtip-cli was obtained but does not execute on this platform.");
  }

  try {
    log("injecting debug IDs…");
    runCli(bin, ["sourcemaps", "inject", DIST]);
  } catch {
    fail("debug-ID injection failed.");
  }

  try {
    log(`uploading source maps for release ${release}…`);
    runCli(bin, ["sourcemaps", "upload", DIST, "--release", release, "--org", org, "--project", project]);
  } catch {
    fail("source-map upload failed.");
  }

  log("upload complete.");
  pruneMaps("uploaded to GlitchTip");
}

main().catch((e) => {
  // An unexpected throw fails the build ONLY when this is a monitored deploy.
  // Without credentials (contributor/preview-without-token) the build must stay
  // green, so degrade to a skip rather than a hard failure.
  if (missingCredentials(process.env).length > 0) {
    log(`skipping upload after a non-fatal error (no credentials): ${e?.message ?? e}`);
    try {
      pruneMaps("no upload credentials");
    } catch {
      /* best effort */
    }
    return;
  }
  fail(`unexpected error — ${e?.message ?? e}`);
});
