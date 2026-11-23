import { spawn } from "child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { log } from "./logger.js";
import { TDL_INSTALL_DIR, appInstallDirectory, bundleRoot, executableDirectory } from "./bundlePaths.js";

const TDL_FILES = ["PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl", "PesoWise-Reports.tdl"];

/** Copy TDL + config beside the exe (first run). No Program Files install. */
export function installBundledFiles(): { tdlDir: string; appDir: string } {
  const appDir = appInstallDirectory();
  const src = bundleRoot();
  mkdirSync(TDL_INSTALL_DIR, { recursive: true });

  const cfgDest = join(appDir, "setup-config.json");
  if (!existsSync(cfgDest)) {
    for (const from of [
      join(src, "setup-config.json"),
      join(executableDirectory(), "setup-config.json"),
    ]) {
      if (existsSync(from)) {
        copyFileSync(from, cfgDest);
        break;
      }
    }
  }

  for (const f of TDL_FILES) {
    const from = join(src, f);
    if (existsSync(from)) copyFileSync(from, join(TDL_INSTALL_DIR, f));
  }
  const tdlSub = join(src, "tdl");
  if (existsSync(tdlSub)) {
    cpSync(tdlSub, join(TDL_INSTALL_DIR, "tdl"), { recursive: true });
  }

  log(`TDL ready at ${TDL_INSTALL_DIR} (app folder ${appDir})`);
  return { tdlDir: TDL_INSTALL_DIR, appDir };
}

export function listMissingTdl(): string[] {
  const missing: string[] = [];
  for (const f of TDL_FILES) {
    if (!existsSync(join(TDL_INSTALL_DIR, f))) missing.push(f);
  }
  return missing;
}

export function openFolderInExplorer(dir: string): void {
  try {
    spawn("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* optional */
  }
}

export function bundleFileNames(): string[] {
  const root = bundleRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root);
}
