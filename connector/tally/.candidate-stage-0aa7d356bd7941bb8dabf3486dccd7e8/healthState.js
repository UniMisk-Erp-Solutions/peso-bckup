"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthStatePath = healthStatePath;
exports.writeHealthSnapshot = writeHealthSnapshot;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const HEALTH_PATH = (0, path_1.join)((0, os_1.homedir)(), "PesoWise", "TallyConnector", "health.json");
function healthStatePath() {
    return HEALTH_PATH;
}
function writeHealthSnapshot(snapshot) {
    (0, fs_1.mkdirSync)((0, path_1.join)((0, os_1.homedir)(), "PesoWise", "TallyConnector"), { recursive: true });
    (0, fs_1.writeFileSync)(HEALTH_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
}
