"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCAL_BRIDGE_PORT = exports.LOCAL_BRIDGE_HOST = void 0;
exports.startLocalBridge = startLocalBridge;
exports.startServeMode = startServeMode;
const node_http_1 = __importDefault(require("node:http"));
const config_js_1 = require("./config.js");
const logger_js_1 = require("./logger.js");
const deliverJob_js_1 = require("./deliverJob.js");
const doctor_js_1 = require("./doctor.js");
const serviceLoop_js_1 = require("./serviceLoop.js");
const tallyClient_js_1 = require("./tallyClient.js");
exports.LOCAL_BRIDGE_HOST = "127.0.0.1";
exports.LOCAL_BRIDGE_PORT = 9876;
let deliverInFlight = null;
let deliverInFlightJobId = null;
function corsHeaders(origin) {
    const allow = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? origin : "http://localhost:3000";
    return {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}
function startLocalBridge() {
    const server = node_http_1.default.createServer((req, res) => {
        const origin = req.headers.origin;
        const cors = corsHeaders(typeof origin === "string" ? origin : undefined);
        if (req.method === "OPTIONS") {
            res.writeHead(204, cors);
            res.end();
            return;
        }
        if (req.method === "GET" && (req.url === "/v1/health" || req.url === "/v1/status")) {
            void (async () => {
                let paired = false;
                let tallyReachable = false;
                let companyName = null;
                const metaReady = false;
                const companyOnHttp = null;
                try {
                    const cfg = (0, config_js_1.loadConfig)();
                    paired = Boolean(cfg.deviceToken);
                    companyName = cfg.tallyCompanyName?.trim() || null;
                    const tally = new tallyClient_js_1.TallyClient({
                        host: cfg.tallyHost,
                        port: cfg.tallyPort,
                        companyName: cfg.tallyCompanyName,
                    });
                    tallyReachable = await tally.isReachable();
                }
                catch {
                    /* not paired yet */
                }
                res.writeHead(200, { ...cors, "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    ok: true,
                    service: "pesowise-tally-bridge",
                    delivery_in_progress: deliverInFlight != null,
                    delivery_job_id: deliverInFlightJobId,
                    connector_paired: paired,
                    tally_reachable: tallyReachable,
                    tally_company_name: companyName,
                    tally_company_on_http: companyOnHttp,
                    metadata_import_ready: metaReady,
                }));
            })();
            return;
        }
        if (req.method === "POST" && req.url === "/v1/config") {
            let body = "";
            req.on("data", (c) => {
                body += c;
            });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body || "{}");
                    const name = String(parsed.tally_company_name ?? "").trim();
                    if (!name) {
                        res.writeHead(400, { ...cors, "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "tally_company_name required" }));
                        return;
                    }
                    (0, config_js_1.saveConfig)({ tallyCompanyName: name });
                    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, tally_company_name: name }));
                }
                catch (e) {
                    res.writeHead(500, { ...cors, "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }
        if (req.method === "POST" && req.url === "/v1/deliver-job") {
            let body = "";
            req.on("data", (c) => {
                body += c;
            });
            req.on("end", () => {
                void (async () => {
                    let jobId = "";
                    try {
                        const parsed = JSON.parse(body || "{}");
                        jobId = String(parsed.job_id ?? "").trim();
                        if (!jobId) {
                            res.writeHead(400, { ...cors, "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "job_id required" }));
                            return;
                        }
                        if (deliverInFlight) {
                            if (deliverInFlightJobId === jobId) {
                                res.writeHead(202, { ...cors, "Content-Type": "application/json" });
                                res.end(JSON.stringify({ accepted: true, job_id: jobId, already_in_progress: true }));
                                return;
                            }
                            res.writeHead(409, { ...cors, "Content-Type": "application/json" });
                            res.end(JSON.stringify({
                                error: "delivery_in_progress",
                                job_id: deliverInFlightJobId,
                            }));
                            return;
                        }
                        res.writeHead(202, { ...cors, "Content-Type": "application/json" });
                        res.end(JSON.stringify({ accepted: true, job_id: jobId }));
                        const cfg = (0, config_js_1.loadConfig)();
                        deliverInFlightJobId = jobId;
                        deliverInFlight = (0, deliverJob_js_1.deliverEntireJob)(cfg, jobId, doctor_js_1.AGENT_VERSION).finally(() => {
                            deliverInFlight = null;
                            deliverInFlightJobId = null;
                        });
                        const result = await deliverInFlight;
                        (0, logger_js_1.log)(`bridge deliver-job finished: ${JSON.stringify(result)}`);
                    }
                    catch (e) {
                        (0, logger_js_1.log)(`bridge error: ${e.message}`);
                    }
                })();
            });
            return;
        }
        res.writeHead(404, cors);
        res.end();
    });
    server.listen(exports.LOCAL_BRIDGE_PORT, exports.LOCAL_BRIDGE_HOST, () => {
        (0, logger_js_1.log)(`Local Tally bridge http://${exports.LOCAL_BRIDGE_HOST}:${exports.LOCAL_BRIDGE_PORT}`);
    });
    return server;
}
/** HTTP bridge + background connector loop (auto-deliver without UI nudges). */
function startServeMode() {
    startLocalBridge();
    void (async () => {
        try {
            const cfg = (0, config_js_1.loadConfig)();
            if (!cfg.deviceToken) {
                (0, logger_js_1.log)("Connector not paired — Sync will queue until you pair once (see docs/tally-integration).");
                return;
            }
            const doctor = await (0, doctor_js_1.runDoctor)();
            (0, logger_js_1.log)(`Connector ready org=${cfg.organizationId ?? "?"} tally=${doctor.tally_localhost ? "up" : "offline"}`);
            await (0, serviceLoop_js_1.runServiceLoop)(cfg);
        }
        catch (e) {
            (0, logger_js_1.log)(`Serve mode: ${e.message}`);
        }
    })();
}
