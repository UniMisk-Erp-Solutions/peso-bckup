"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_VERSION = void 0;
exports.runDoctor = runDoctor;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const config_js_1 = require("./config.js");
const pesoApi_js_1 = require("./pesoApi.js");
const tallyClient_js_1 = require("./tallyClient.js");
const logger_js_1 = require("./logger.js");
const tallyTcpCheck_js_1 = require("./tallyTcpCheck.js");
exports.AGENT_VERSION = "0.6.0-company-verify";
/** Diagnostics may issue one read-only company Export; never claim, acknowledge, or import. */
async function runDoctor() {
    const cfgPath = (0, config_js_1.configPath)();
    const report = {
        agent_version: exports.AGENT_VERSION,
        config_present: (0, fs_1.existsSync)(cfgPath),
        config_path: cfgPath,
        organization_id: null,
        connector_id: null,
        tally_company: null,
        backend_reachable: false,
        backend_authenticated: false,
        tally_localhost: false,
        tally_company_found: false,
        tally_company_verification: "company_probe_unavailable",
        delivery_ready: false,
        logs_writable: false,
        readonly: true,
    };
    try {
        (0, fs_1.accessSync)((0, path_1.join)((0, os_1.homedir)(), "PesoWise", "TallyConnector"), fs_1.constants.W_OK);
        report.logs_writable = true;
    }
    catch {
        report.logs_writable = false;
    }
    if (!report.config_present)
        return report;
    const cfg = (0, config_js_1.loadConfig)();
    report.organization_id = cfg.organizationId ?? null;
    report.connector_id = cfg.connectorId ?? null;
    report.tally_company = cfg.tallyCompanyName ?? null;
    if (!report.tally_company?.trim()) {
        report.tally_company_verification = "not_configured";
    }
    const host = cfg.tallyHost ?? "127.0.0.1";
    const port = cfg.tallyPort ?? 9000;
    try {
        report.tally_localhost = await (0, tallyTcpCheck_js_1.checkTcpPort)(host, port, tallyTcpCheck_js_1.DOCTOR_TALLY_TCP_TIMEOUT_MS);
    }
    catch {
        report.tally_localhost = false;
    }
    if (cfg.tallyCompanyName?.trim() && report.tally_localhost) {
        const tally = new tallyClient_js_1.TallyClient({ host, port, companyName: cfg.tallyCompanyName });
        const company = await tally.verifyActiveCompany(cfg.tallyCompanyName);
        report.tally_company_found = company.verified;
        report.tally_company_verification = company.verified ? "verified" : company.reason;
    }
    if (cfg.deviceToken && cfg.pesoApiUrl) {
        try {
            const api = new pesoApi_js_1.PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken);
            await api.heartbeat(exports.AGENT_VERSION);
            report.backend_reachable = true;
            report.backend_authenticated = true;
        }
        catch {
            report.backend_reachable = false;
        }
    }
    (0, logger_js_1.log)(`doctor: config=${report.config_present} backend=${report.backend_authenticated} tally_tcp=${report.tally_localhost} company_verify=${report.tally_company_verification}`);
    return report;
}
