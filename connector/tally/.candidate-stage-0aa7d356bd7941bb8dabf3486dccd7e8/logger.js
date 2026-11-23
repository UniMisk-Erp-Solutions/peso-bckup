"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logFilePath = logFilePath;
exports.log = log;
exports.logError = logError;
exports.installGlobalErrorHandlers = installGlobalErrorHandlers;
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const LOG_DIR = (0, path_1.join)((0, os_1.homedir)(), "PesoWise", "TallyConnector");
const LOG_PATH = (0, path_1.join)(LOG_DIR, "connector.log");
const MAX = 2_000_000;
function logFilePath() {
    return LOG_PATH;
}
function redact(line) {
    return line
        .replace(/device_token=\S+/gi, "device_token=[REDACTED]")
        .replace(/X-Connector-Token:\s*\S+/gi, "X-Connector-Token: [REDACTED]")
        .replace(/"device_token"\s*:\s*"[^"]+"/gi, '"device_token":"[REDACTED]"');
}
function rotateIfNeeded() {
    try {
        const st = (0, fs_1.statSync)(LOG_PATH);
        if (st.size > MAX) {
            const backup = `${LOG_PATH}.1`;
            try {
                (0, fs_1.unlinkSync)(backup);
            }
            catch {
                /* no prior backup */
            }
            (0, fs_1.copyFileSync)(LOG_PATH, backup);
            (0, fs_1.appendFileSync)(LOG_PATH, "", { flag: "w" });
        }
    }
    catch {
        /* new file */
    }
}
function log(line) {
    (0, fs_1.mkdirSync)(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    const row = `${new Date().toISOString()} ${redact(line)}\n`;
    (0, fs_1.appendFileSync)(LOG_PATH, row, "utf-8");
}
function logError(line, err) {
    const detail = err instanceof Error ? err.message : err != null ? String(err) : "";
    log(detail ? `${line}: ${detail}` : line);
}
/** Production: survive unhandled rejections without silent exit. */
function installGlobalErrorHandlers() {
    process.on("uncaughtException", (e) => {
        logError("uncaughtException", e);
    });
    process.on("unhandledRejection", (reason) => {
        logError("unhandledRejection", reason);
    });
}
