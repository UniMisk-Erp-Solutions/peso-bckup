#!/usr/bin/env node
/**
 * Phase 5.1 — read-only prechecks, ONE metadata import, readback. No retries on import fail.
 */
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";
import http from "http";

const host = process.env.TALLY_HOST ?? "127.0.0.1";
const port = Number(process.env.TALLY_PORT ?? "9000");
const company = "PesoWise Integration Test";
const vchType = "PesoWise Report Meta";
const token = `PW-META51-${Date.now().toString(36)}`;

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlText(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tallyPost(xml, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method: "POST",
        headers: {
          "Content-Type": "text/xml;charset=utf-8",
          "Content-Length": Buffer.byteLength(xml, "utf8"),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function exportCollection(collectionId, withCompany) {
  const c = escapeXmlText(company);
  const co = withCompany
    ? `<SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY>`
    : "";
  return `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${collectionId}</ID></HEADER><BODY><DESC><STATICVARIABLES>${co}<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
}

function wrapImport(inner) {
  const c = escapeXmlText(company);
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

function extractUdfJson(xml) {
  for (const re of [
    /<PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/PESOWISE_METADATA_JSON>/i,
    /<UDF:PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/UDF:PESOWISE_METADATA_JSON>/i,
  ]) {
    const m = xml.match(re);
    if (m) return decodeXmlText(m[1].trim());
  }
  return null;
}

function failBlocked(stage, detail) {
  console.log(JSON.stringify({ result: "METADATA ROUND-TRIP BLOCKED", stage, ...detail }));
  process.exit(1);
}

console.log("=== READ-ONLY PRECHECKS ===");

let health;
try {
  health = await tallyPost(exportCollection("Company", false), 20_000);
} catch (e) {
  failBlocked("health", { reason: "endpoint_unreachable", message: e.message });
}

if (health.status !== 200 || health.text.length < 100) {
  failBlocked("health", { http: health.status, body_excerpt: health.text.slice(0, 120) });
}
if (health.text.includes("TallyPrime Server is Running") && health.text.length < 80) {
  failBlocked("health", { reason: "tally_server_no_data" });
}
const companyOk =
  health.text.includes('NAME="PesoWise Integration Test"') || health.text.includes(">PesoWise Integration Test<");
console.log("check_endpoint", true, "check_company_in_catalog", companyOk);
if (!companyOk) {
  console.log(JSON.stringify({ result: "MANUAL ACTION REQUIRED", reason: "company_not_in_catalog" }));
  process.exit(2);
}

let vtExport;
try {
  vtExport = await tallyPost(exportCollection("Voucher Type", true), 30_000);
} catch (e) {
  failBlocked("voucher_type_read", { reason: "timeout_or_error", message: e.message });
}

if (vtExport.text.includes("TallyPrime Server is Running")) {
  failBlocked("voucher_type_read", {
    reason: "company_not_loaded_on_integration_server",
    hint: "Open PesoWise Integration Test in TallyPrime with ODBC/HTTP integration enabled",
  });
}

const vtOk = vtExport.text.includes(vchType);
console.log("check_voucher_type_readback", vtOk, "export_len", vtExport.text.length);
if (!vtOk) {
  console.log(JSON.stringify({ result: "MANUAL ACTION REQUIRED", reason: "voucher_type_not_found_in_export", expected: vchType }));
  process.exit(2);
}

let activeCo;
try {
  activeCo = await tallyPost(exportCollection("Company", true), 30_000);
} catch (e) {
  failBlocked("active_company", { message: e.message });
}
const activeOk = activeCo.text.length > 200 && !activeCo.text.includes("TallyPrime Server is Running");
console.log("check_company_active_context", activeOk);
if (!activeOk) {
  failBlocked("active_company", { body_excerpt: activeCo.text.slice(0, 200) });
}

console.log("=== PRECHECKS PASS — ONE METADATA IMPORT ===");

const payload = {
  schema_version: 1,
  report_type: "claim_verification",
  roundtrip_token: token,
  fields: {
    ascii: "plain ASCII",
    note: "Unicode नोट",
    amp: "A & B",
    lt: "<tag>",
    gt: ">x<",
    quotes: '"double"',
    nl: "line1\nline2",
    nested: { k: "v", n: 1 },
  },
};
const metaJson = JSON.stringify(payload);
const narration = `Phase51 metadata ${token}`;
const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="${vchType}"><DATE>20260406</DATE><NARRATION>${escapeXmlText(narration)}</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">${escapeXmlText(metaJson)}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`;

let imp;
try {
  imp = await tallyPost(wrapImport(inner), 60_000);
} catch (e) {
  failBlocked("import", { reason: "timeout", message: e.message, classification: "D_other_or_tally_unstable" });
}

const parsed = parseTallyImportResponse(imp.text);
const exceptions = Number(/<EXCEPTIONS[^>]*>(\d+)/i.exec(imp.text)?.[1] ?? -1);
const lineErrors = [...imp.text.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);
console.log("import_response", {
  created: parsed.created,
  altered: parsed.altered,
  exceptions,
  lineErrors,
  parsed_ok: parsed.ok,
});
console.log("import_body", imp.text.trim());

const importPass =
  lineErrors.length === 0 && exceptions === 0 && (parsed.created >= 1 || parsed.altered >= 1) && parsed.ok;

if (!importPass) {
  let classification = "D_other";
  if (lineErrors.some((e) => /udf|field|unknown/i.test(e))) classification = "A_udf_definition_context";
  else if (lineErrors.some((e) => /voucher|type|ledger|entry/i.test(e))) classification = "C_voucher_structure";
  else if (exceptions === 1 && lineErrors.length === 0) classification = "B_or_C_xml_or_voucher_structure";
  failBlocked("import", {
    created: parsed.created,
    altered: parsed.altered,
    exceptions,
    lineErrors,
    classification,
    xml_shape_note:
      "Same envelope as working PesoWise Expense micro-test (All Masters + SVCURRENTCOMPANY); metadata adds xmlns:UDF and UDF:PESOWISE_METADATA_JSON on VOUCHER without ledger lines (Journal-based meta type)",
  });
}

console.log("=== READBACK ===");
let ex;
try {
  ex = await tallyPost(
    `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VOUCHER</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${escapeXmlText(company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20260430</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`,
    60_000,
  );
} catch (e) {
  failBlocked("readback", { reason: "timeout", message: e.message });
}

const hasToken = ex.text.includes(token);
const readJson = extractUdfJson(ex.text);
console.log("readback_has_narration_token", hasToken, "udf_extracted", !!readJson);

if (!readJson || !hasToken) {
  failBlocked("readback", { reason: "udf_or_voucher_not_found_in_export", export_len: ex.text.length, classification: "A_udf_definition_context" });
}

let readObj;
try {
  readObj = JSON.parse(readJson);
} catch {
  failBlocked("readback", { reason: "invalid_json_in_udf", read_excerpt: readJson.slice(0, 200) });
}

if (JSON.stringify(readObj) !== JSON.stringify(payload)) {
  failBlocked("readback", { reason: "json_mismatch", sent: payload, read: readObj });
}

console.log(JSON.stringify({ result: "METADATA ROUND-TRIP PASS", token, created: parsed.created, exceptions }));
