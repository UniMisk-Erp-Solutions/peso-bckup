#!/usr/bin/env node
/**
 * One customer download: public/downloads/PesoWiseSync.exe (+ optional README).
 * Embeds Supabase URL/anon key from .env.local into pkg bundle.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const connectorRoot = join(root, "connector", "tally");
const tdlSrc = join(root, "tally-extension");
const publicExe = join(root, "public", "downloads", "PesoWiseSync.exe");
const stageOnly = process.argv.includes("--stage-only");
const installerOut = join(root, "installer", "out");

function loadEnvLocal() {
  const p = join(root, ".env.local");
  if (!existsSync(p)) {
    console.warn("No .env.local — using existing connector/tally/bundle/setup-config.json if present.");
    return null;
  }
  const text = readFileSync(p, "utf-8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return env;
}

function main() {
  const env = loadEnvLocal();
  mkdirSync(join(connectorRoot, "bundle"), { recursive: true });
  if (env) {
    const url = env.VITE_SUPABASE_URL;
    const anon = env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const company = env.VITE_DEFAULT_TALLY_COMPANY_NAME?.trim() || "PesoWise Integration Test";
    if (url && anon) {
      writeFileSync(
        join(connectorRoot, "bundle", "setup-config.json"),
        JSON.stringify({ peso_api_url: url, anon_key: anon, default_tally_company: company }, null, 2),
        "utf-8",
      );
    }
  }

  for (const f of ["PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl", "PesoWise-Reports.tdl"]) {
    cpSync(join(tdlSrc, f), join(connectorRoot, "bundle", f));
  }
  cpSync(join(tdlSrc, "tdl"), join(connectorRoot, "bundle", "tdl"), { recursive: true });

  const pkg = spawnSync("npm.cmd", ["run", stageOnly ? "build" : "package:win"], {
    cwd: connectorRoot,
    stdio: "inherit",
    shell: true,
  });
  if (pkg.status !== 0) process.exit(pkg.status ?? 1);

  if (stageOnly) {
    const stagedExe = join(installerOut, "PesoWiseSync.exe");
    const exeBuild = spawnSync(
      process.execPath,
      [join(connectorRoot, "scripts", "build-win-exe.mjs"), stagedExe],
      { cwd: connectorRoot, stdio: "inherit", windowsHide: true },
    );
    if (exeBuild.error) throw exeBuild.error;
    if (exeBuild.status !== 0) process.exit(exeBuild.status ?? 1);
  }

  const built = stageOnly
    ? join(installerOut, "PesoWiseSync.exe")
    : join(connectorRoot, "dist", "PesoWiseSync.exe");
  if (!existsSync(built)) {
    console.error("Missing", built);
    process.exit(1);
  }

  if (stageOnly) {
    mkdirSync(installerOut, { recursive: true });
    for (const f of ["PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl", "PesoWise-Reports.tdl"]) {
      copyFileSync(join(tdlSrc, f), join(installerOut, f));
    }
    cpSync(join(tdlSrc, "tdl"), join(installerOut, "tdl"), { recursive: true, force: true });
    console.log("Staged connector and current TDL modules in installer/out (public downloads unchanged).");
    return;
  }

  mkdirSync(join(root, "public", "downloads"), { recursive: true });
  copyFileSync(built, publicExe);

  writeFileSync(
    join(root, "public", "downloads", "PESOWISE-SYNC-README.txt"),
    [
      "PesoWise Sync — standalone connector executable",
      "",
      "For the one-time graphical installation, use PesoWise-Tally-Setup.exe.",
      "The standalone executable opens setup/status when double-clicked; scheduled startup runs it in the background.",
      "In Tally, enable the HTTP port 9000 (F1).",
      "In PesoWise: Reports → Sync to Tally.",
      "",
    ].join("\r\n"),
    "utf-8",
  );

  console.log("\nStandalone connector download:", publicExe);
}

main();
