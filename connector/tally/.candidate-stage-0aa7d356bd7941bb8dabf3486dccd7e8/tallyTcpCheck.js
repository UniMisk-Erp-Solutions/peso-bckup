"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_TALLY_TCP_TIMEOUT_MS = exports.DOCTOR_TALLY_TCP_TIMEOUT_MS = void 0;
exports.checkTcpPort = checkTcpPort;
const node_net_1 = require("node:net");
/** Doctor: one TCP probe, no HTTP/XML to Tally. */
exports.DOCTOR_TALLY_TCP_TIMEOUT_MS = 3_000;
/** Agent idle loop: one TCP probe before claim/delivery. */
exports.AGENT_TALLY_TCP_TIMEOUT_MS = 3_000;
/**
 * Single-shot TCP connect — no retry, no fallback, no Tally XML.
 * Returns false on timeout, error, or immediate close.
 */
function checkTcpPort(host, port, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            resolve(ok);
        };
        const socket = (0, node_net_1.connect)({ host, port });
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
    });
}
