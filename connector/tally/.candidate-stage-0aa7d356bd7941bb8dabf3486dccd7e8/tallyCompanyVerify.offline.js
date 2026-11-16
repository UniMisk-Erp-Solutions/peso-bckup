"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeCompanyVerifyResponse = analyzeCompanyVerifyResponse;
function decodeXml(value) {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
function analyzeCompanyVerifyResponse(expectedCompany, xml) {
    const expected = expectedCompany.trim();
    const names = [...xml.matchAll(/<(?:NAME|SERVERCOMPANYNAME)\b[^>]*>([\s\S]*?)<\/(?:NAME|SERVERCOMPANYNAME)>/gi)]
        .map((match) => decodeXml(match[1].trim()));
    return {
        nameMatched: Boolean(expected) && names.includes(expected),
        couldNotFindCompany: /Could not find Company/i.test(xml),
        lineError: /<LINEERROR\b/i.test(xml),
    };
}
