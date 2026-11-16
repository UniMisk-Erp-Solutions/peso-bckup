"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newInstallationId = newInstallationId;
const node_crypto_1 = require("node:crypto");
/** RFC 4122 v4 UUID — Node crypto (pkg snapshot safe; no globalThis.crypto). */
function newInstallationId() {
    return (0, node_crypto_1.randomUUID)();
}
