"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installBundledFiles = installBundledFiles;
exports.listMissingTdl = listMissingTdl;
exports.openFolderInExplorer = openFolderInExplorer;
exports.bundleFileNames = bundleFileNames;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const logger_js_1 = require("./logger.js");
const bundlePaths_js_1 = require("./bundlePaths.js");
const TDL_FILES = ["PesoWise-Bootstrap.tdl", "PesoWise-Load.tdl", "PesoWise-Reports.tdl"];
/** Copy TDL + config beside the exe (first run). No Program Files install. */
function installBundledFiles() {
    const appDir = (0, bundlePaths_js_1.appInstallDirectory)();
    const src = (0, bundlePaths_js_1.bundleRoot)();
    (0, fs_1.mkdirSync)(bundlePaths_js_1.TDL_INSTALL_DIR, { recursive: true });
    const cfgDest = (0, path_1.join)(appDir, "setup-config.json");
    if (!(0, fs_1.existsSync)(cfgDest)) {
        for (const from of [
            (0, path_1.join)(src, "setup-config.json"),
            (0, path_1.join)((0, bundlePaths_js_1.executableDirectory)(), "setup-config.json"),
        ]) {
            if ((0, fs_1.existsSync)(from)) {
                (0, fs_1.copyFileSync)(from, cfgDest);
                break;
            }
        }
    }
    for (const f of TDL_FILES) {
        const from = (0, path_1.join)(src, f);
        if ((0, fs_1.existsSync)(from))
            (0, fs_1.copyFileSync)(from, (0, path_1.join)(bundlePaths_js_1.TDL_INSTALL_DIR, f));
    }
    const tdlSub = (0, path_1.join)(src, "tdl");
    if ((0, fs_1.existsSync)(tdlSub)) {
        (0, fs_1.cpSync)(tdlSub, (0, path_1.join)(bundlePaths_js_1.TDL_INSTALL_DIR, "tdl"), { recursive: true });
    }
    (0, logger_js_1.log)(`TDL ready at ${bundlePaths_js_1.TDL_INSTALL_DIR} (app folder ${appDir})`);
    return { tdlDir: bundlePaths_js_1.TDL_INSTALL_DIR, appDir };
}
function listMissingTdl() {
    const missing = [];
    for (const f of TDL_FILES) {
        if (!(0, fs_1.existsSync)((0, path_1.join)(bundlePaths_js_1.TDL_INSTALL_DIR, f)))
            missing.push(f);
    }
    return missing;
}
function openFolderInExplorer(dir) {
    try {
        (0, child_process_1.spawn)("explorer.exe", [dir], { detached: true, stdio: "ignore" }).unref();
    }
    catch {
        /* optional */
    }
}
function bundleFileNames() {
    const root = (0, bundlePaths_js_1.bundleRoot)();
    if (!(0, fs_1.existsSync)(root))
        return [];
    return (0, fs_1.readdirSync)(root);
}
