"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPackagedExecutable = isPackagedExecutable;
exports.isProductionConnectorRuntime = isProductionConnectorRuntime;
/** True when running as pkg-produced PesoWiseConnector.exe (not node dist/main.js). */
function isPackagedExecutable() {
    return typeof process.pkg !== "undefined";
}
function isProductionConnectorRuntime() {
    return isPackagedExecutable() || process.env.PESOWISE_CONNECTOR_PRODUCTION === "1";
}
