"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TallyClient = void 0;
exports.buildActiveCompanyProbeXml = buildActiveCompanyProbeXml;
exports.parseActiveCompanyProbeResponse = parseActiveCompanyProbeResponse;
const responseParser_js_1 = require("./responseParser.js");
const tallyTcpCheck_js_1 = require("./tallyTcpCheck.js");
const tallyDelivery_js_1 = require("./tallyDelivery.js");
const COMPANY_PROBE_TIMEOUT_MS = 5_000;
/**
 * Read-only Export request. It deliberately omits SVCURRENTCOMPANY so it cannot
 * request another company or make Tally load/select one. The inline TDL only
 * exports the current SVCurrentCompany value; it defines no actions or writes.
 */
function buildActiveCompanyProbeXml() {
    return [
        "<ENVELOPE>",
        "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PesoWiseActiveCompanyProbe</ID></HEADER>",
        "<BODY><DESC>",
        "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>",
        "<TDL><TDLMESSAGE>",
        '<OBJECT NAME="PesoWiseActiveCompanyProbeObject"><LOCALFORMULA>PWActiveCompany:##SVCurrentCompany</LOCALFORMULA></OBJECT>',
        '<COLLECTION NAME="PesoWiseActiveCompanyProbe" ISMODIFY="No"><OBJECT>PesoWiseActiveCompanyProbeObject</OBJECT><FETCH>PWActiveCompany</FETCH></COLLECTION>',
        "</TDLMESSAGE></TDL>",
        "</DESC></BODY></ENVELOPE>",
    ].join("");
}
/** Strictly accepts one successful Tally response with exactly one company value. */
function parseActiveCompanyProbeResponse(xml, expectedCompany) {
    const expected = expectedCompany.trim();
    if (!expected)
        return { verified: false, reason: "company_not_configured" };
    if (!xml.trim())
        return { verified: false, reason: "company_probe_unavailable" };
    const roots = [...xml.matchAll(/<ENVELOPE\b[^>]*>([\s\S]*?)<\/ENVELOPE\s*>/gi)];
    if (roots.length !== 1 || /<LINEERROR\b/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
        return { verified: false, reason: "company_probe_unavailable" };
    }
    const status = [...roots[0][1].matchAll(/<STATUS\b[^>]*>\s*(-?\d+)\s*<\/STATUS\s*>/gi)];
    if (status.length !== 1 || status[0][1] !== "1") {
        return { verified: false, reason: "company_probe_unavailable" };
    }
    const values = [...roots[0][1].matchAll(/<PWACTIVECompany\b[^>]*>([\s\S]*?)<\/PWACTIVECompany\s*>/gi)]
        .map((match) => decodeXmlText(match[1].replace(/<[^>]+>/g, "").trim()));
    if (values.length !== 1 || !values[0]) {
        return { verified: false, reason: "company_identity_ambiguous" };
    }
    return values[0] === expected
        ? { verified: true, companyName: values[0] }
        : { verified: false, reason: "company_identity_mismatch" };
}
function decodeXmlText(value) {
    return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
class TallyClient {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    /** Probe the active company using a read-only Export request; never import or select. */
    async verifyActiveCompany(expectedName) {
        const expected = expectedName.trim();
        if (!expected)
            return { verified: false, reason: "company_not_configured" };
        try {
            const response = await fetch(this.baseUrl(), {
                method: "POST",
                headers: { "Content-Type": "text/xml;charset=utf-8" },
                body: buildActiveCompanyProbeXml(),
                signal: AbortSignal.timeout(COMPANY_PROBE_TIMEOUT_MS),
            });
            if (!response.ok)
                return { verified: false, reason: "company_probe_unavailable" };
            return parseActiveCompanyProbeResponse(await response.text(), expected);
        }
        catch {
            return { verified: false, reason: "company_probe_unavailable" };
        }
    }
    baseUrl() {
        return `http://${this.opts.host}:${this.opts.port}`;
    }
    /** TCP only — no HTTP/XML (safe idle / doctor reachability). */
    async isReachable() {
        try {
            return await (0, tallyTcpCheck_js_1.checkTcpPort)(this.opts.host, this.opts.port, tallyTcpCheck_js_1.AGENT_TALLY_TCP_TIMEOUT_MS);
        }
        catch {
            return false;
        }
    }
    /** One Import POST — no retry, no fallback (timeoutMs capped at 15s). */
    async postImportXmlOnce(xml, timeoutMs = tallyDelivery_js_1.TALLY_DELIVERY_POST_TIMEOUT_MS) {
        const ms = Math.min(Math.max(timeoutMs, 1_000), tallyDelivery_js_1.TALLY_DELIVERY_POST_TIMEOUT_MS);
        const res = await fetch(this.baseUrl(), {
            method: "POST",
            headers: { "Content-Type": "text/xml;charset=utf-8" },
            body: xml,
            signal: AbortSignal.timeout(ms),
        });
        const text = await res.text();
        const parsed = (0, responseParser_js_1.parseTallyImportResponse)(text);
        return { httpOk: res.ok, text, parsed };
    }
    /** Delivery path — delegates to single-attempt POST (production loop). */
    async postXml(xml) {
        return this.postImportXmlOnce(xml, tallyDelivery_js_1.TALLY_DELIVERY_POST_TIMEOUT_MS);
    }
}
exports.TallyClient = TallyClient;
