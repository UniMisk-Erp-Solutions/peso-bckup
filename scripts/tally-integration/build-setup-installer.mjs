#!/usr/bin/env node
/** Compile the customer-facing Inno Setup installer (not the connector EXE). */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(join(fileURLToPath(new URL(".", import.meta.url)), "../.."));
const project = join(root, "installer", "PesoWise-for-Tally-Setup.iss");
const payloadDir = join(root, "installer", "out");
const output = join(root, "installer", "release", "PesoWise-Tally-Setup.exe");
const requiredPayload = [
  "PesoWiseSync.exe",
  "Install-PesoWise-Tally.ps1",
  "Uninstall-PesoWise-User.ps1",
  "Uninstall-PesoWise-Tally.ps1",
  "Run-PesoWiseConnector-Hidden.vbs",
  "PesoWise-Bootstrap.tdl",
  "PesoWise-Load.tdl",
  "PesoWise-Reports.tdl",
  "tdl",
];

if (!existsSync(project)) throw new Error(`Missing Inno Setup project: ${project}`);
const connectorBuild = spawnSync(
  process.execPath,
  [join(root, "scripts", "tally-integration", "build-pesowise-sync.mjs"), "--stage-only"],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (connectorBuild.error) throw connectorBuild.error;
if (connectorBuild.status !== 0) process.exit(connectorBuild.status ?? 1);
for (const name of requiredPayload) {
  if (!existsSync(join(payloadDir, name))) throw new Error(`Missing installer payload: ${join(payloadDir, name)}`);
}

const candidates = [
  process.env.INNO_SETUP_COMPILER,
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Inno Setup 6", "ISCC.exe"),
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Inno Setup 6", "ISCC.exe"),
  process.env.ProgramFiles && join(process.env.ProgramFiles, "Inno Setup 7", "ISCC.exe"),
  process.env["ProgramFiles(x86)"] && join(process.env["ProgramFiles(x86)"], "Inno Setup 7", "ISCC.exe"),
].filter(Boolean);
const compiler = candidates.find((candidate) => existsSync(candidate));
if (!compiler) {
  console.error("Inno Setup 6/7 compiler not found. Install Inno Setup from JRSoftware or set INNO_SETUP_COMPILER to ISCC.exe.");
  process.exit(2);
}

const result = spawnSync(compiler, [project], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(output) || statSync(output).size < 1024 * 1024) {
  throw new Error(`Inno Setup did not produce a plausible installer at ${output}`);
}
const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
console.log(`Installer: ${output}`);
console.log(`SHA-256: ${digest}`);
