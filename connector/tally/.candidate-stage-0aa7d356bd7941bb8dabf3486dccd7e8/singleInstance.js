"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentLockPath = agentLockPath;
exports.acquireSingleInstanceLock = acquireSingleInstanceLock;
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const LOCK = (0, path_1.join)((0, os_1.homedir)(), "PesoWise", "TallyConnector", "agent.lock");
function agentLockPath() {
    return LOCK;
}
function acquireSingleInstanceLock() {
    try {
        const fd = (0, fs_1.openSync)(LOCK, "wx");
        (0, fs_1.writeSync)(fd, String(process.pid));
        (0, fs_1.closeSync)(fd);
        return {
            release: () => {
                try {
                    (0, fs_1.unlinkSync)(LOCK);
                }
                catch {
                    /* ignore */
                }
            },
        };
    }
    catch {
        throw new Error("PesoWise Tally Agent is already running (single-instance lock).");
    }
}
