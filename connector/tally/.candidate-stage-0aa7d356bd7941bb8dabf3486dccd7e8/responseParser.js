"use strict";
/** Parse TallyPrime HTTP integration XML responses — fail closed (connector copy). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTallyImportResponse = parseTallyImportResponse;
function tagValue(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
    const m = xml.match(re);
    return m ? m[1].trim() : null;
}
function strictIntTag(xml, tag) {
    const matches = [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([^<]*)<\\/${tag}>`, "gi"))];
    if (matches.length !== 1 || !/^\s*\d+\s*$/.test(matches[0][1]))
        return null;
    const value = Number(matches[0][1].trim());
    return Number.isSafeInteger(value) ? value : null;
}
function parseTallyImportResponse(xml) {
    const excerpt = xml.slice(0, 8000);
    if (!xml.trim()) {
        return {
            ok: false,
            created: 0,
            altered: 0,
            deleted: 0,
            exceptions: 0,
            errors: ["empty Tally response"],
            ignored: 0,
            lastVchId: null,
            lastMid: null,
            rawExcerpt: excerpt,
        };
    }
    const lineError = /<LINEERROR>([^<]*)<\/LINEERROR>/gi;
    const errors = [];
    let m;
    while ((m = lineError.exec(xml)) !== null) {
        errors.push(m[1].trim());
    }
    const rootMatch = xml.match(/^\s*(?:<\?xml[^>]*\?>\s*)?<(RESPONSE|ENVELOPE)\b/i);
    const rootName = rootMatch?.[1];
    const rootIsResponse = Boolean(rootName
        && [...xml.matchAll(new RegExp(`<${rootName}\\b`, "gi"))].length === 1
        && [...xml.matchAll(new RegExp(`<\\/${rootName}\\s*>`, "gi"))].length === 1
        && new RegExp(`<${rootName}\\b[\\s\\S]*<\\/${rootName}\\s*>\\s*$`, "i").test(xml));
    const envelopeStatus = rootName?.toUpperCase() === "ENVELOPE" ? strictIntTag(xml, "STATUS") : 1;
    const created = strictIntTag(xml, "CREATED");
    const altered = strictIntTag(xml, "ALTERED");
    const deleted = strictIntTag(xml, "DELETED");
    const ignored = strictIntTag(xml, "IGNORED");
    const tallyErrors = strictIntTag(xml, "ERRORS");
    const exceptionTags = [...xml.matchAll(/<EXCEPTIONS\b[^>]*>([^<]*)<\/EXCEPTIONS>/gi)];
    const exceptions = exceptionTags.length === 0 ? 0 : strictIntTag(xml, "EXCEPTIONS");
    const lastVchId = tagValue(xml, "LASTVCHID");
    const lastMid = tagValue(xml, "LASTMID");
    const countersValid = [created, altered, deleted, ignored, tallyErrors].every((n) => n !== null)
        && (exceptionTags.length === 0 || exceptions !== null);
    const confirmed = (created ?? 0) + (altered ?? 0) + (deleted ?? 0);
    if (tallyErrors !== null && tallyErrors > 0)
        errors.push(`Tally reported ${tallyErrors} import error(s)`);
    // Any exception, ignored row, or line error may mean partial delivery. Only a complete,
    // structurally recognizable response with a positive persisted action is acknowledged.
    const ok = rootIsResponse && envelopeStatus === 1 && countersValid && errors.length === 0
        && tallyErrors === 0 && exceptions === 0 && ignored === 0 && confirmed > 0;
    return {
        ok,
        created: created ?? 0,
        altered: altered ?? 0,
        deleted: deleted ?? 0,
        exceptions: exceptions ?? 0,
        errors,
        ignored: ignored ?? 0,
        lastVchId,
        lastMid,
        rawExcerpt: excerpt,
    };
}
