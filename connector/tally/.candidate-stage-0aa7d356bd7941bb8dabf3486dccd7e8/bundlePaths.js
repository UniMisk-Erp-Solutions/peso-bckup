"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_INSTALL_DIR = exports.TDL_INSTALL_DIR = void 0;
exports.executableDirectory = executableDirectory;
exports.bundleRoot = bundleRoot;
exports.appInstallDirectory = appInstallDirectory;
const fs_1 = require("fs");
const path_1 = require("path");
const runtime_js_1 = require("./runtime.js");
/** dist/*.js → connector/tally/bundle in dev; pkg snapshot …/bundle when packaged. */
const moduleDir = __dirname;
/** Directory containing the running .exe (or connector root in dev). */
function executableDirectory() {
    if ((0, runtime_js_1.isPackagedExecutable)()) {
        return (0, path_1.dirname)(process.execPath);
    }
    return (0, path_1.join)(__dirname, "..");
}
/** TDL + setup-config (pkg embeds under snapshot …/bundle; dev uses connector/tally/bundle). */
function bundleRoot() {
    const candidates = [
        (0, path_1.join)(moduleDir, "..", "bundle"),
        (0, path_1.join)(executableDirectory(), "bundle"),
        executableDirectory(),
    ];
    for (const p of candidates) {
        if ((0, fs_1.existsSync)((0, path_1.join)(p, "setup-config.json")) || (0, fs_1.existsSync)((0, path_1.join)(p, "PesoWise-Load.tdl"))) {
            return p;
        }
    }
    return (0, path_1.join)(executableDirectory(), "bundle");
}
exports.TDL_INSTALL_DIR = "C:\\pesowise";
/** Folder containing the running agent (same as the .exe — no Program Files copy). */
function appInstallDirectory() {
    return executableDirectory();
}
/** @deprecated use appInstallDirectory() */
exports.APP_INSTALL_DIR = appInstallDirectory();
