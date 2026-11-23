"use strict";
/** Adapt metadata ledger XML for TallyPrime bootstrap / import readiness. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.demoteIndexedMetadataXmlToPlain = demoteIndexedMetadataXmlToPlain;
exports.metadataXmlUsesIndexedUdks = metadataXmlUsesIndexedUdks;
exports.metadataLedgerCreateToAlterOnly = metadataLedgerCreateToAlterOnly;
const INDEXED_UDF_LIST = /<UDF:([A-Z0-9_]+)\.LIST[^>]*INDEX="(\d+)"[^>]*>\s*<UDF:\1[^>]*>([\s\S]*?)<\/UDF:\1>\s*<\/UDF:\1\.LIST>/gi;
/** Downgrade indexed UDF LIST blocks to plain TYPE="String" (imports without Bootstrap TDL). */
function demoteIndexedMetadataXmlToPlain(xml) {
    return xml.replace(INDEXED_UDF_LIST, (_m, name, _index, value) => {
        return `<UDF:${name} TYPE="String">${value}</UDF:${name}>`;
    });
}
function metadataXmlUsesIndexedUdks(xml) {
    return /PESOWISE_METADATA_JSON\.LIST/i.test(xml) || /INDEX="25001"/i.test(xml);
}
/** Duplicate Create → Alter with UDFs only (refresh report fields on existing PW-META ledgers). */
function metadataLedgerCreateToAlterOnly(tallyMessageXml) {
    if (!/<LEDGER ACTION="Create"/i.test(tallyMessageXml))
        return null;
    let out = tallyMessageXml.replace(/<LEDGER ACTION="Create"/i, '<LEDGER ACTION="Alter"');
    out = out.replace(/\s*<PARENT>[\s\S]*?<\/PARENT>\s*/gi, "\n    ");
    out = out.replace(/\s*<UDF:PESOWISE_STABLE_KEY[\s\S]*?<\/UDF:PESOWISE_STABLE_KEY>\s*/gi, "\n    ");
    return out;
}
