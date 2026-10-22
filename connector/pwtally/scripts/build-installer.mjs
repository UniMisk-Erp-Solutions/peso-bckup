#!/usr/bin/env node
/**
 * Builds dist/PesoWise-Tally-Setup.exe with Windows' built-in IExpress (no extra download).
 * The installer runs `PesoWiseTally.exe setup` directly: no cmd, no PowerShell, no ExecutionPolicy Bypass, no VBScript.
 * Inputs: dist/PesoWiseTally.exe (npm run build), tdl/PesoWise-Tally.tdl (node scripts/gen-tdl.mjs).
 * The embedded setup-config.json carries ONLY the public API base URL and the publishable (anon) key.
 */
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
// IExpress fails on long paths containing spaces, so build in a short temp path and copy the result back.
const work = join(tmpdir(), "pwtbuild");
const stage = join(work, "stage");
const out = join(work, "PesoWise-Tally-Setup.exe");
const finalOut = join(root, "dist", "PesoWise-Tally-Setup.exe");

for (const f of [join(root, "dist", "PesoWiseTally.exe"), join(root, "tdl", "PesoWise-Tally.tdl")]) {
  if (!existsSync(f)) {
    console.error("Missing", f, "- run `node scripts/build.mjs` and `node scripts/gen-tdl.mjs` first");
    process.exit(1);
  }
}

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = readFileSync(join(repo, ".env.local"), "utf-8").match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  } catch {
    return undefined;
  }
}
const apiBase = process.env.PWT_API_BASE ?? envValue("VITE_SUPABASE_URL");
const apiKey = process.env.PWT_API_KEY ?? envValue("VITE_SUPABASE_PUBLISHABLE_KEY");
if (!apiBase || !/^https:\/\//.test(apiBase)) {
  console.error("Set PWT_API_BASE (https URL) or VITE_SUPABASE_URL in .env.local");
  process.exit(1);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
copyFileSync(join(root, "dist", "PesoWiseTally.exe"), join(stage, "PesoWiseTally.exe"));
copyFileSync(join(root, "tdl", "PesoWise-Tally.tdl"), join(stage, "PesoWise-Tally.tdl"));
writeFileSync(join(stage, "setup-config.json"), JSON.stringify({ apiBase, apiKey, tallyUrl: "http://127.0.0.1:9000" }, null, 2));

const files = ["PesoWiseTally.exe", "PesoWise-Tally.tdl", "setup-config.json"];
const sed = [
  "[Version]", "Class=IEXPRESS", "SEDVersion=3",
  "[Options]", "PackagePurpose=InstallApp", "ShowInstallProgressWindow=0", "HideExtractAnimation=1", "UseLongFileName=1",
  "InsideCompressed=0", "CAB_FixedSize=0", "CAB_ResvCodeSigning=0", "RebootMode=N",
  "InstallPrompt=%InstallPrompt%", "DisplayLicense=%DisplayLicense%", "FinishMessage=%FinishMessage%",
  "TargetName=%TargetName%", "FriendlyName=%FriendlyName%", "AppLaunched=%AppLaunched%", "PostInstallCmd=%PostInstallCmd%",
  "AdminQuietInstCmd=%AdminQuietInstCmd%", "UserQuietInstCmd=%UserQuietInstCmd%",
  "SourceFiles=SourceFiles",
  "[Strings]",
  "InstallPrompt=", "DisplayLicense=", "FinishMessage=", "TargetName=" + out, "FriendlyName=PesoWise Tally Setup",
  "AppLaunched=PesoWiseTally.exe setup", "PostInstallCmd=<None>", "AdminQuietInstCmd=", "UserQuietInstCmd=",
  ...files.map((f, i) => `FILE${i}="${f}"`),
  "[SourceFiles]", "SourceFiles0=" + stage + "\\",
  "[SourceFiles0]",
  ...files.map((_, i) => `%FILE${i}%=`),
].join("\r\n");
const sedPath = join(work, "setup.sed");
writeFileSync(sedPath, sed, "ascii");

rmSync(out, { force: true });
const r = spawnSync("iexpress.exe", ["/N", "/Q", sedPath], { stdio: "inherit" });
// IExpress returns before the file is fully written in some builds; wait briefly.
for (let i = 0; i < 20 && !existsSync(out); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
if (!existsSync(out)) {
  console.error("IExpress did not produce the installer (exit", r.status, ")");
  process.exit(1);
}
copyFileSync(out, finalOut);
console.log("Built", finalOut);

// Publish for the website's setup page (served at /downloads/*). Build output only: git-ignored, host these on your CDN/storage in production.
const pub = join(repo, "public", "downloads");
mkdirSync(pub, { recursive: true });
copyFileSync(out, join(pub, "PesoWise-Tally-Setup.exe"));
// The .tdl is NOT published on the website (it ships inside the installer only).
console.log("Published to", pub);
