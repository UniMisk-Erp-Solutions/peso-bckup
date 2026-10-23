#!/usr/bin/env node
/**
 * Builds ONE self-contained download, dist/PesoWise-Tally-Setup.exe (the pkg program itself; no IExpress self-extractor).
 * Windows Defender / SmartScreen treat IExpress self-extractors that launch a program as suspicious (Wacatac/Sabsik "!ml");
 * the plain program is not flagged. The public API base URL, the publishable key and the TDL are compiled in at build time.
 * Double-clicking it runs setup (see main.ts). Optional signing: PWT_SIGN_PFX / PWT_SIGN_PASSWORD, as in build-installer.mjs.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..", "..");
const require = createRequire(join(repo, "package.json"));
const esbuild = require("esbuild");

function envValue(name) {
  if (process.env[name]) return process.env[name];
  try {
    const m = readFileSync(join(repo, ".env.local"), "utf-8").match(new RegExp(`^${name}=(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  } catch { return undefined; }
}
const apiBase = process.env.PWT_API_BASE ?? envValue("VITE_SUPABASE_URL");
const apiKey = process.env.PWT_API_KEY ?? envValue("VITE_SUPABASE_PUBLISHABLE_KEY");
if (!apiBase || !/^https:\/\//.test(apiBase)) { console.error("Set PWT_API_BASE (https URL) or VITE_SUPABASE_URL in .env.local"); process.exit(1); }
const tdl = join(root, "tdl", "PesoWise-Tally.tdl");
if (!existsSync(tdl)) { console.error("Missing", tdl, "- run `node scripts/gen-tdl.mjs` first"); process.exit(1); }

mkdirSync(join(root, "dist"), { recursive: true });
const cjs = join(root, "dist", "PesoWiseSetup.cjs");
await esbuild.build({
  entryPoints: [join(root, "src", "main.ts")], bundle: true, platform: "node", target: "node18", format: "cjs", outfile: cjs, logLevel: "info",
  define: {
    PWT_EMBED_CFG: JSON.stringify(JSON.stringify({ apiBase, apiKey, tallyUrl: "http://127.0.0.1:9000" })),
    PWT_EMBED_TDL: JSON.stringify(readFileSync(tdl, "utf-8")),
  },
});
const pkgBin = [join(repo, "connector", "tally", "node_modules", "pkg", "lib-es5", "bin.js"), join(repo, "node_modules", "pkg", "lib-es5", "bin.js")].find(existsSync);
if (!pkgBin) { console.error("pkg not found"); process.exit(1); }
const out = join(root, "dist", "PesoWise-Tally-Setup.exe");
const r = spawnSync(process.execPath, [pkgBin, cjs, "--targets", "node18-win-x64", "--output", out], { cwd: root, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
if (process.env.PWT_SIGN_PFX) {
  const ps = ["$ErrorActionPreference = 'Stop'",
    "$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:PWT_SIGN_PFX, $env:PWT_SIGN_PASSWORD)",
    "$ts = if ($env:PWT_SIGN_TIMESTAMP) { $env:PWT_SIGN_TIMESTAMP } else { 'http://timestamp.digicert.com' }",
    "$r = Set-AuthenticodeSignature -FilePath $env:PWT_SIGN_FILE -Certificate $c -HashAlgorithm SHA256 -TimestampServer $ts",
    "if (-not $r.SignerCertificate) { throw ('signing failed: ' + $r.StatusMessage) }"].join("; ");
  const s = spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "inherit", env: { ...process.env, PWT_SIGN_FILE: out } });
  if (s.status !== 0) { console.error("Code signing failed; not published."); process.exit(1); }
} else console.log("Note: NOT signed (set PWT_SIGN_PFX / PWT_SIGN_PASSWORD to sign).");
console.log("Built", out);
