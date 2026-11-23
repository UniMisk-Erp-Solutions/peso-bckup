"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deliverEntireJob = deliverEntireJob;
const logger_js_1 = require("./logger.js");
const pesoApi_js_1 = require("./pesoApi.js");
const tallyClient_js_1 = require("./tallyClient.js");
const deliverBatch_js_1 = require("./deliverBatch.js");
const tallyTcpCheck_js_1 = require("./tallyTcpCheck.js");
const MAX_BATCHES_PER_JOB = 10_000;
const WAIT_BATCHES_MS = 2000;
const WAIT_BATCHES_ATTEMPTS = 120;
async function deliverEntireJob(cfg, jobId, agentVersion) {
    if (!cfg.deviceToken)
        throw new Error("deviceToken missing — pair first");
    const peso = new pesoApi_js_1.PesoConnectorApi(cfg.pesoApiUrl, cfg.deviceToken);
    const tally = new tallyClient_js_1.TallyClient({
        host: cfg.tallyHost,
        port: cfg.tallyPort,
        companyName: cfg.tallyCompanyName,
    });
    const companyCheck = await tally.verifyActiveCompany(cfg.tallyCompanyName ?? "");
    if (!companyCheck.verified) {
        return {
            job_id: jobId,
            batches_attempted: 0,
            batches_succeeded: 0,
            batches_failed: 0,
            stopped_reason: "company_unverified",
        };
    }
    await peso.heartbeat(agentVersion);
    const tcpOk = await (0, tallyTcpCheck_js_1.checkTcpPort)(cfg.tallyHost ?? "127.0.0.1", cfg.tallyPort ?? 9000, tallyTcpCheck_js_1.DOCTOR_TALLY_TCP_TIMEOUT_MS);
    if (!tcpOk) {
        return {
            job_id: jobId,
            batches_attempted: 0,
            batches_succeeded: 0,
            batches_failed: 0,
            stopped_reason: "tally_offline",
        };
    }
    let batchesAttempted = 0;
    let batchesSucceeded = 0;
    let batchesFailed = 0;
    for (let attempt = 0; attempt < WAIT_BATCHES_ATTEMPTS; attempt++) {
        const plan = await peso.jobBatches(jobId);
        if (plan.batches.length === 0) {
            await sleep(WAIT_BATCHES_MS);
            continue;
        }
        const pending = plan.batches
            .filter((b) => b.status === "pending")
            .sort((a, b) => a.batch_index - b.batch_index);
        const claimed = plan.batches.filter((b) => b.status === "claimed").length;
        if (pending.length === 0) {
            if (claimed > 0) {
                await sleep(WAIT_BATCHES_MS);
                continue;
            }
            break;
        }
        for (const b of pending) {
            if (batchesAttempted >= MAX_BATCHES_PER_JOB)
                break;
            (0, logger_js_1.log)(`Deliver job=${jobId} batch=${b.id} idx=${b.batch_index}`);
            const r = await (0, deliverBatch_js_1.deliverBoundBatch)(cfg, peso, tally, jobId, b.id);
            if (r.error_safe === "claim_refused") {
                (0, logger_js_1.log)(`Skip batch=${b.id} (claim refused — likely in-flight elsewhere)`);
                continue;
            }
            batchesAttempted += 1;
            if (r.success)
                batchesSucceeded += 1;
            else
                batchesFailed += 1;
        }
        // Keep draining pending batches; job-level failure is decided server-side after all batches are acked.
    }
    const finalPlan = await peso.jobBatches(jobId);
    const stillPending = finalPlan.batches.some((b) => b.status === "pending");
    if (finalPlan.batches.length === 0) {
        return {
            job_id: jobId,
            batches_attempted: batchesAttempted,
            batches_succeeded: batchesSucceeded,
            batches_failed: batchesFailed,
            stopped_reason: "no_batches_timeout",
        };
    }
    return {
        job_id: jobId,
        batches_attempted: batchesAttempted,
        batches_succeeded: batchesSucceeded,
        batches_failed: batchesFailed,
        stopped_reason: stillPending ? "partial_failure" : "complete",
    };
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
