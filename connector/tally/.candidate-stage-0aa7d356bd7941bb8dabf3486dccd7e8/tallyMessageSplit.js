"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitTallyMessages = splitTallyMessages;
exports.postTallyMessageWithDuplicateAlter = postTallyMessageWithDuplicateAlter;
exports.postTallyBatchVerified = postTallyBatchVerified;
function splitTallyMessages(envelopeXml) {
    return envelopeXml
        .split(/(?=<TALLYMESSAGE)/i)
        .filter((p) => p.includes("<TALLYMESSAGE"));
}
function wrapOneMessage(inner, companyEsc) {
    const reportName = /<VOUCHER\b/i.test(inner)
        ? "Vouchers"
        : "All Masters";
    return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY>
<IMPORTDATA>
<REQUESTDESC>
<REPORTNAME>${reportName}</REPORTNAME>
<STATICVARIABLES>
<SVCURRENTCOMPANY>${companyEsc}</SVCURRENTCOMPANY>
</STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
${inner.trim()}
</REQUESTDATA>
</IMPORTDATA>
</BODY>
</ENVELOPE>`;
}
/**
 * One attempt only. No automatic Create-to-Alter fallback.
 * A duplicate must be handled through explicit reconciliation.
 */
async function postTallyMessageWithDuplicateAlter(tally, inner, companyEsc) {
    const { parsed } = await tally.postImportXmlOnce(wrapOneMessage(inner, companyEsc));
    return parsed;
}
/**
 * No blind retry or per-message replay after an ambiguous response.
 */
async function postTallyBatchVerified(tally, envelopeXml, _companyEsc) {
    const { httpOk, parsed } = await tally.postImportXmlOnce(envelopeXml);
    if (!httpOk) {
        throw new Error("Tally returned an unsuccessful HTTP status; import outcome uncertain");
    }
    return parsed;
}
