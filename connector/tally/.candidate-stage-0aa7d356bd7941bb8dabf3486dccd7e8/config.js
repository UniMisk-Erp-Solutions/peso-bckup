"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configPath = configPath;
exports.configExists = configExists;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.ensureInstallationId = ensureInstallationId;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const randomId_js_1 = require("./randomId.js");
const CONFIG_DIR = (0, path_1.join)((0, os_1.homedir)(), "PesoWise", "TallyConnector");
const CONFIG_PATH = (0, path_1.join)(CONFIG_DIR, "config.json");
function configPath() {
    return CONFIG_PATH;
}
function configExists() {
    return (0, fs_1.existsSync)(CONFIG_PATH);
}
function loadConfig() {
    if (!(0, fs_1.existsSync)(CONFIG_PATH)) {
        throw new Error(`Missing config at ${CONFIG_PATH}. Run setup first (double-click PesoWise Setup).`);
    }
    const text = (0, fs_1.readFileSync)(CONFIG_PATH, "utf-8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text);
    return {
        ...raw,
        logMaxBytes: raw.logMaxBytes ?? 2_000_000,
        tallyHost: raw.tallyHost ?? "127.0.0.1",
        tallyPort: raw.tallyPort ?? 9000,
    };
}
function saveConfig(partial) {
    (0, fs_1.mkdirSync)(CONFIG_DIR, { recursive: true });
    let base = {
        configVersion: 1,
        pesoApiUrl: "",
        tallyHost: "127.0.0.1",
        tallyPort: 9000,
        installationId: "",
        logMaxBytes: 2_000_000,
    };
    if ((0, fs_1.existsSync)(CONFIG_PATH)) {
        base = { ...base, ...JSON.parse((0, fs_1.readFileSync)(CONFIG_PATH, "utf-8").replace(/^\uFEFF/, "")) };
    }
    const next = { ...base, ...partial };
    (0, fs_1.writeFileSync)(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
    return next;
}
function ensureInstallationId(cfg) {
    if (cfg.installationId && cfg.installationId.length >= 8)
        return cfg.installationId;
    const id = (0, randomId_js_1.newInstallationId)();
    saveConfig({ installationId: id });
    return id;
}
