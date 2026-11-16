"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runServiceLoop = runServiceLoop;
const pesoApi_js_1 = require("./pesoApi.js");
const tallyClient_js_1 = require("./tallyClient.js");
const logger_js_1 = require("./logger.js");
const doctor_js_1 = require("./doctor.js");
const deliverBatch_js_1 = require("./deliverBatch.js");
const healthState_js_1 = require("./healthState.js");
const VERSION = doctor_js_1.AGENT_VERSION;
function publishHealth(cfg, partial) {
    (0, healthState_js_1.writeHealthSnapshot)({
        updated_at: new Date().toISOString(),
        agent_version: VERSION,
        connector_paired: Boolean(cfg.deviceToken),
        organization_id: cfg.organizationId ?? null,
        tally_reachable: partial.tally_reachable,
        tally_company_name: cfg.tallyCompanyName ?? null,
        last_delivery_batch_id: partial.last_delivery_batch_id ?? null,
        last_delivery_ok: partial.last_delivery_ok ?? null,
        last_error_safe: partial.last_error_safe ?? null,
    });
}
async function runServiceLoop(cfg) {
    if (!cfg.deviceToken)
        throw new Error("deviceToken missing — pair first");
    const peso = new pesoApi_js_1.PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken);
    const tally = new tallyClient_js_1.TallyClient({
        host: cfg.tallyHost,
        port: cfg.tallyPort,
        companyName: cfg.tallyCompanyName,
    });
    let backoffMs = 5000;
    for (;;) {
        try {
            await peso.heartbeat(VERSION);
            const up = await tally.isReachable();
            if (!up) {
                (0, logger_js_1.log)("Tally offline — retry later");
                await sleep(backoffMs);
                backoffMs = Math.min(backoffMs * 2, 120_000);
                continue;
            }
            backoffMs = 5000;
            // Configured company name and TCP reachability do not establish the active company.
            // Keep the service healthy, but claim queued financial data only when the read-only
            // export probe reports the exact configured active company.
            const companyCheck = await tally.verifyActiveCompany(cfg.tallyCompanyName ?? "");
            if (!companyCheck.verified) {
                (0, logger_js_1.log)(`Delivery paused: ${companyCheck.reason}; no delivery batches will be claimed`);
                publishHealth(cfg, { tally_reachable: true, last_error_safe: companyCheck.reason });
                await sleep(10_000);
                continue;
            }
            const claim = await peso.claim(cfg.tallyCompanyName ?? "");
            if (!claim.claimed) {
                await sleep(10_000);
                continue;
            }
            (0, logger_js_1.log)(`Delivering batch ${claim.batch_id} job=${claim.job_id} idx=${claim.batch_index}`);
            const result = await (0, deliverBatch_js_1.deliverClaimedBatch)(cfg, peso, tally, claim);
            if (!result.success && !result.skipped_empty) {
                (0, logger_js_1.log)(`Batch ${claim.batch_id} delivery failed: ${result.error_safe ?? "unknown"}`);
            }
        }
        catch (e) {
            (0, logger_js_1.log)(`Loop error: ${e.message}`);
            await sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, 120_000);
        }
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
