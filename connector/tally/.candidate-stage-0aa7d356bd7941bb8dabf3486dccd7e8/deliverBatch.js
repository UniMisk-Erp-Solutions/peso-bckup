"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.injectTallyCompany = injectTallyCompany;
exports.useTallyActiveCompany = useTallyActiveCompany;
exports.deliverClaimedBatch = deliverClaimedBatch;
exports.deliverBoundBatch = deliverBoundBatch;
const logger_js_1 = require("./logger.js");
function injectTallyCompany(xml, company) {
    const name = company.trim();
    if (!name)
        throw new Error("Tally company is not configured");
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new Error("Tally XML declarations are not permitted");
    const envelopeOpen = [...xml.matchAll(/<ENVELOPE\b[^>]*>/gi)];
    const envelopeClose = [...xml.matchAll(/<\/ENVELOPE\s*>/gi)];
    if (envelopeOpen.length !== 1 || envelopeClose.length !== 1 || envelopeOpen[0].index > envelopeClose[0].index) {
        throw new Error("Tally XML envelope is missing or malformed");
    }
    const tags = [...xml.matchAll(/<SVCURRENTCOMPANY\b[^>]*>([\s\S]*?)<\/SVCURRENTCOMPANY>/gi)];
    if (tags.length !== 1)
        throw new Error("Tally XML must contain exactly one company field");
    const current = tags[0][1].trim();
    const escapeXmlText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const field = tags[0][0];
    if (current === "<!-- configured at connector time -->") {
        return xml.replace(field, `<SVCURRENTCOMPANY>${escapeXmlText(name)}</SVCURRENTCOMPANY>`);
    }
    if (current !== escapeXmlText(name) && current !== name) {
        throw new Error("Tally XML company does not match the configured company");
    }
    return xml;
}
/** Active-company fallback is prohibited because it can direct data to another company. */
function useTallyActiveCompany(xml) {
    void xml;
    throw new Error("Using the active Tally company is disabled; company identity is unverified");
}
/** Deliver once, only after a live read-only active-company check matches the intended company. */
async function deliverClaimedBatch(cfg, peso, tally, claim) {
    const batchId = claim.batch_id;
    if (claim.message_count === 0) {
        await peso.ack({ batch_id: batchId, success: true, ack_summary: { skipped_empty: true } });
        return { batch_id: batchId, success: true, skipped_empty: true };
    }
    const configuredCompany = cfg.tallyCompanyName?.trim();
    const backendCompany = claim.tally_company_name?.trim();
    let errorSafe = null;
    let tallyResponseSafe;
    if (!configuredCompany || !backendCompany || configuredCompany !== backendCompany) {
        errorSafe = "Tally company configuration mismatch or missing";
    }
    else {
        try {
            // Validate the frozen XML's target without posting it.
            const xml = injectTallyCompany(claim.xml, configuredCompany);
            const companyCheck = await tally.verifyActiveCompany(configuredCompany);
            if ("reason" in companyCheck) {
                errorSafe = `Active Tally company is not verified (${companyCheck.reason}); reconcile before retry`;
            }
            else if (companyCheck.companyName !== configuredCompany) {
                errorSafe = "Active Tally company identity mismatch; reconcile before retry";
            }
            else {
                const response = await tally.postImportXmlOnce(xml);
                tallyResponseSafe = response.text.slice(0, 4000);
                if (!response.httpOk || !response.parsed.ok) {
                    errorSafe = response.parsed.errors.join("; ").slice(0, 500)
                        || `Tally import outcome was not a complete clean success (HTTP ${response.httpOk ? "ok" : "error"}); reconcile before retry`;
                }
                else {
                    await peso.ack({
                        batch_id: batchId,
                        success: true,
                        tally_response_safe: tallyResponseSafe,
                        ack_summary: {
                            created: response.parsed.created,
                            altered: response.parsed.altered,
                            deleted: response.parsed.deleted,
                            ignored: response.parsed.ignored,
                            exceptions: response.parsed.exceptions,
                            errors: response.parsed.errors,
                            last_vch_id: response.parsed.lastVchId,
                            last_mid: response.parsed.lastMid,
                        },
                        delivery_updates: claim.delivery_updates ?? [],
                    });
                    (0, logger_js_1.log)(`Delivered batch=${batchId} company=${configuredCompany}`);
                    return { batch_id: batchId, success: true };
                }
            }
        }
        catch (error) {
            errorSafe = `${error.message.slice(0, 350)}; delivery outcome may be unknown, reconcile before retry`;
        }
    }
    // An unsuccessful ack is quarantined by the database; it cannot silently requeue the batch.
    const safeError = errorSafe ?? "Delivery outcome unknown; reconcile before retry";
    (0, logger_js_1.log)(`Delivery blocked batch=${batchId}: ${safeError}`);
    await peso.ack({ batch_id: batchId, success: false, error_safe: safeError, tally_response_safe: tallyResponseSafe });
    return { batch_id: batchId, success: false, error_safe: safeError };
}
/** Bound/manual delivery checks identity before claim, then rechecks immediately before import. */
async function deliverBoundBatch(cfg, peso, tally, jobId, batchId) {
    void jobId;
    if (!cfg.tallyCompanyName?.trim())
        throw new Error("Tally company is not configured");
    const companyName = cfg.tallyCompanyName.trim();
    const companyCheck = await tally.verifyActiveCompany(companyName);
    if ("reason" in companyCheck) {
        (0, logger_js_1.log)(`Bound delivery blocked batch=${batchId}: ${companyCheck.reason}`);
        return { batch_id: batchId, success: false, error_safe: companyCheck.reason };
    }
    if (companyCheck.companyName !== companyName) {
        return { batch_id: batchId, success: false, error_safe: "Active Tally company identity mismatch" };
    }
    const claim = await peso.claimBound(jobId, batchId, companyName);
    if (!claim.claimed)
        return { batch_id: batchId, success: false, error_safe: "claim_refused" };
    return deliverClaimedBatch(cfg, peso, tally, claim);
}
