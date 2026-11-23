import { existsSync, readFileSync, unlinkSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { configExists } from "./config.js";
import { log } from "./logger.js";
import { isPackagedExecutable } from "./runtime.js";
import { agentLockPath } from "./singleInstance.js";

function cleanupStaleLock(): void {
  const lock = agentLockPath();
  if (!existsSync(lock)) return;
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      unlinkSync(lock);
      return;
    }
    process.kill(pid, 0);
  } catch {
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
}

export function isSyncWorkerRunning(): boolean {
  cleanupStaleLock();
  const lock = agentLockPath();
  if (!existsSync(lock)) return false;
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start hidden worker (survives when this launcher process exits). */
export function spawnBackgroundSync(): boolean {
  if (isSyncWorkerRunning()) {
    log("Background sync worker already running");
    return true;
  }
  const exe = process.execPath.replace(/'/g, "''");
  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `Start-Process -FilePath '${exe}' -ArgumentList 'run' -WindowStyle Hidden`,
      ],
      { windowsHide: true, stdio: "ignore", timeout: 20_000 },
    );
    if (ps.status === 0) {
      log("Started background sync worker (hidden process)");
      return true;
    }
    log(`Start-Process failed status=${ps.status}`);
  }
  spawn(process.execPath, ["run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  log("Started background sync worker (detached fallback)");
  return true;
}

/** Optional dialog — use sparingly (first setup only). */
export function notifyUser(message: string, title = "PesoWise Sync"): void {
  if (process.platform !== "win32") {
    console.log(`${title}: ${message}`);
    return;
  }
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    `[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)})`,
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
  });
}

export function shouldUseSimpleLauncher(noSubcommand: boolean): boolean {
  return isPackagedExecutable() && noSubcommand;
}

export type LauncherResult = "setup_needed" | "worker_started" | "worker_already_running";

/** Double-click launcher: ensure worker is running, then exit immediately. */
export function runPackagedLauncher(): LauncherResult {
  if (!configExists()) return "setup_needed";
  if (isSyncWorkerRunning()) return "worker_already_running";
  spawnBackgroundSync();
  return "worker_started";
}

/** First-time pairing: new window stays open until Connect (do not close until browser says Connected). */
export function startSetupWindow(): void {
  const exe = process.execPath.replace(/'/g, "''");
  if (process.platform === "win32") {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath '${exe}' -ArgumentList 'setup' -WindowStyle Normal`,
      ],
      { windowsHide: true, stdio: "ignore", timeout: 20_000 },
    );
    return;
  }
  spawn(process.execPath, ["setup"], { detached: true, stdio: "inherit" }).unref();
}
