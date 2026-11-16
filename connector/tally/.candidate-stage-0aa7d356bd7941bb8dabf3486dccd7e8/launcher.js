"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSyncWorkerRunning = isSyncWorkerRunning;
exports.spawnBackgroundSync = spawnBackgroundSync;
exports.notifyUser = notifyUser;
exports.shouldUseSimpleLauncher = shouldUseSimpleLauncher;
exports.runPackagedLauncher = runPackagedLauncher;
exports.startSetupWindow = startSetupWindow;
const fs_1 = require("fs");
const child_process_1 = require("child_process");
const config_js_1 = require("./config.js");
const logger_js_1 = require("./logger.js");
const runtime_js_1 = require("./runtime.js");
const singleInstance_js_1 = require("./singleInstance.js");
function cleanupStaleLock() {
    const lock = (0, singleInstance_js_1.agentLockPath)();
    if (!(0, fs_1.existsSync)(lock))
        return;
    try {
        const pid = Number.parseInt((0, fs_1.readFileSync)(lock, "utf8").trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0) {
            (0, fs_1.unlinkSync)(lock);
            return;
        }
        process.kill(pid, 0);
    }
    catch {
        try {
            (0, fs_1.unlinkSync)(lock);
        }
        catch {
            /* ignore */
        }
    }
}
function isSyncWorkerRunning() {
    cleanupStaleLock();
    const lock = (0, singleInstance_js_1.agentLockPath)();
    if (!(0, fs_1.existsSync)(lock))
        return false;
    try {
        const pid = Number.parseInt((0, fs_1.readFileSync)(lock, "utf8").trim(), 10);
        if (!Number.isFinite(pid) || pid <= 0)
            return false;
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** Start hidden worker (survives when this launcher process exits). */
function spawnBackgroundSync() {
    if (isSyncWorkerRunning()) {
        (0, logger_js_1.log)("Background sync worker already running");
        return true;
    }
    const exe = process.execPath.replace(/'/g, "''");
    if (process.platform === "win32") {
        const ps = (0, child_process_1.spawnSync)("powershell.exe", [
            "-NoProfile",
            "-WindowStyle",
            "Hidden",
            "-Command",
            `Start-Process -FilePath '${exe}' -ArgumentList 'run' -WindowStyle Hidden`,
        ], { windowsHide: true, stdio: "ignore", timeout: 20_000 });
        if (ps.status === 0) {
            (0, logger_js_1.log)("Started background sync worker (hidden process)");
            return true;
        }
        (0, logger_js_1.log)(`Start-Process failed status=${ps.status}`);
    }
    (0, child_process_1.spawn)(process.execPath, ["run"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    }).unref();
    (0, logger_js_1.log)("Started background sync worker (detached fallback)");
    return true;
}
/** Optional dialog — use sparingly (first setup only). */
function notifyUser(message, title = "PesoWise Sync") {
    if (process.platform !== "win32") {
        console.log(`${title}: ${message}`);
        return;
    }
    const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        `[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)})`,
    ].join("; ");
    (0, child_process_1.spawnSync)("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
        windowsHide: true,
        stdio: "ignore",
    });
}
function shouldUseSimpleLauncher(noSubcommand) {
    return (0, runtime_js_1.isPackagedExecutable)() && noSubcommand;
}
/** Double-click launcher: ensure worker is running, then exit immediately. */
function runPackagedLauncher() {
    if (!(0, config_js_1.configExists)())
        return "setup_needed";
    if (isSyncWorkerRunning())
        return "worker_already_running";
    spawnBackgroundSync();
    return "worker_started";
}
/** First-time pairing: new window stays open until Connect (do not close until browser says Connected). */
function startSetupWindow() {
    const exe = process.execPath.replace(/'/g, "''");
    if (process.platform === "win32") {
        (0, child_process_1.spawnSync)("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Start-Process -FilePath '${exe}' -ArgumentList 'setup' -WindowStyle Normal`,
        ], { windowsHide: true, stdio: "ignore", timeout: 20_000 });
        return;
    }
    (0, child_process_1.spawn)(process.execPath, ["setup"], { detached: true, stdio: "inherit" }).unref();
}
