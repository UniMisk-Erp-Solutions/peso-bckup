#!/usr/bin/env node
/**
 * Phase 5.1 — ONE balanced metadata voucher test (ledger lines + UDF).
 */
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";
import http from "http";

const host = "127.0.0.1";
const port = 9000;
const company = "PesoWise Integration Test";
const vchType = "PesoWise Report Meta";
const token = `PW-META-BAL-${Date.now().toString(36)}`;

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

function tallyPost(xml, timeoutMs = 60_000) {
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

function wrapImport(inner) {
  const c = escapeXmlText(company);
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

console.log("=== XML STRUCTURE COMPARISON (redacted) ===");
console.log(
  "A_success_expense:",
  "TALLYMESSAGE>VOUCHER VCHTYPE=PesoWise Expense + DATE + NARRATION + 2x ALLLEDGERENTRIES.LIST (PW-SYNTH-CAT -100 / PW-SYNTH-EMP +100); NO UDF; NO xmlns",
);
console.log(
  "B_failed_meta:",
  "TALLYMESSAGE xmlns:UDF + VOUCHER VCHTYPE=PesoWise Report Meta + DATE + NARRATION + UDF:PESOWISE_METADATA_JSON only; NO ledger lines",
);
console.log(
  "C_this_test:",
  "Same ledger block as A + xmlns:UDF + UDF:PESOWISE_METADATA_JSON; VCHTYPE=PesoWise Report Meta; amount ±1",
);

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
const narration = `Phase51 balanced meta ${token}`;

const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="${vchType}"><DATE>20260406</DATE><NARRATION>${escapeXmlText(narration)}</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>PW-SYNTH-CAT</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>PW-SYNTH-EMP</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1</AMOUNT></ALLLEDGERENTRIES.LIST><UDF:PESOWISE_METADATA_JSON TYPE="String">${escapeXmlText(metaJson)}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`;

const redactedInner = inner.replace(escapeXmlText(metaJson), "[JSON_REDACTED]").replace(token, "[TOKEN]");
console.log("\n=== ONE IMPORT (redacted inner) ===");
console.log(redactedInner);

let imp;
try {
  imp = await tallyPost(wrapImport(inner));
} catch (e) {
  console.log(JSON.stringify({ result: "METADATA BALANCED-VOUCHER TEST BLOCKED", reason: "timeout", message: e.message }));
  process.exit(1);
}

console.log("\n=== TALLY RESPONSE (complete) ===");
console.log(imp.text);

const parsed = parseTallyImportResponse(imp.text);
const errors = Number(/<ERRORS[^>]*>(\d+)/i.exec(imp.text)?.[1] ?? -1);
const exceptions = Number(/<EXCEPTIONS[^>]*>(\d+)/i.exec(imp.text)?.[1] ?? -1);
const lineErrors = [...imp.text.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);

const importPass =
  lineErrors.length === 0 &&
  errors === 0 &&
  exceptions === 0 &&
  (parsed.created >= 1 || parsed.altered >= 1) &&
  parsed.ok;

if (!importPass) {
  console.log(
    JSON.stringify({
      result: "METADATA BALANCED-VOUCHER TEST BLOCKED",
      CREATED: parsed.created,
      ALTERED: parsed.altered,
      ERRORS: errors,
      EXCEPTIONS: exceptions,
      LINEERROR: lineErrors,
      balanced_ledger_structure: "matched_known_working_expense_pattern",
      remaining_variable_if_still_failing: "UDF XML/definition (B/A) — ledger lines now included",
    }),
  );
  process.exit(1);
}

console.log("\n=== READ-ONLY READBACK ===");
const c = escapeXmlText(company);
const exXml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VOUCHER</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20260430</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
let ex;
try {
  ex = await tallyPost(exXml);
} catch (e) {
  console.log(JSON.stringify({ result: "METADATA UDF READBACK BLOCKED", reason: "export_timeout", message: e.message }));
  process.exit(1);
}

const voucherExists = ex.text.includes(token);
console.log("voucher_exists_by_narration_token", voucherExists);

if (!voucherExists) {
  console.log(JSON.stringify({ result: "METADATA UDF READBACK BLOCKED", reason: "voucher_not_found_after_import" }));
  process.exit(1);
}

const udfMatch =
  ex.text.match(/<PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/PESOWISE_METADATA_JSON>/i) ??
  ex.text.match(/<UDF:PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/UDF:PESOWISE_METADATA_JSON>/i);
if (!udfMatch) {
  console.log(JSON.stringify({ result: "METADATA UDF READBACK BLOCKED", reason: "udf_field_absent_in_export" }));
  process.exit(1);
}

const readJson = decodeXmlText(udfMatch[1].trim());
let readObj;
try {
  readObj = JSON.parse(readJson);
} catch {
  console.log(JSON.stringify({ result: "METADATA UDF READBACK BLOCKED", reason: "udf_not_valid_json", excerpt: readJson.slice(0, 200) }));
  process.exit(1);
}

const equal = JSON.stringify(readObj) === JSON.stringify(payload);
if (!equal) {
  console.log(JSON.stringify({ result: "METADATA UDF READBACK BLOCKED", reason: "logical_json_mismatch", read: readObj, sent: payload }));
  process.exit(1);
}

console.log(
  JSON.stringify({
    result: "METADATA ROUND-TRIP PASS",
    CREATED: parsed.created,
    ALTERED: parsed.altered,
    ERRORS: errors,
    EXCEPTIONS: exceptions,
    voucher_persisted: true,
    udf_readback: true,
    logical_equality: true,
    token,
  }),
);
