import { existsSync } from "fs";
import { dirname, join } from "path";
import { isPackagedExecutable } from "./runtime.js";

/** dist/*.js → connector/tally/bundle in dev; pkg snapshot …/bundle when packaged. */
const moduleDir = __dirname;

/** Directory containing the running .exe (or connector root in dev). */
export function executableDirectory(): string {
  if (isPackagedExecutable()) {
    return dirname(process.execPath);
  }
  return join(__dirname, "..");
}

/** TDL + setup-config (pkg embeds under snapshot …/bundle; dev uses connector/tally/bundle). */
export function bundleRoot(): string {
  const candidates = [
    join(moduleDir, "..", "bundle"),
    join(executableDirectory(), "bundle"),
    executableDirectory(),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "setup-config.json")) || existsSync(join(p, "PesoWise-Load.tdl"))) {
      return p;
    }
  }
  return join(executableDirectory(), "bundle");
}

export const TDL_INSTALL_DIR = "C:\\pesowise";

/** Folder containing the running agent (same as the .exe — no Program Files copy). */
export function appInstallDirectory(): string {
  return executableDirectory();
}

/** @deprecated use appInstallDirectory() */
export const APP_INSTALL_DIR = appInstallDirectory();
