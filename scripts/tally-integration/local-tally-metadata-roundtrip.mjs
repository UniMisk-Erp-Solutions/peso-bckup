#!/usr/bin/env node
/**
 * Phase 5.1 — metadata UDF import + readback only (no pairing/sync).
 */
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";
import http from "http";

const host = process.env.TALLY_HOST ?? "127.0.0.1";
const port = process.env.TALLY_PORT ?? "9000";
const company = "PesoWise Integration Test";
const token = `PW-META-RT-${Date.now().toString(36)}`;

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

function extractUdfJson(xml) {
  const patterns = [
    /<PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/PESOWISE_METADATA_JSON>/i,
    /<UDF:PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/UDF:PESOWISE_METADATA_JSON>/i,
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return decodeXmlText(m[1].trim());
  }
  return null;
}

function tallyPost(xml, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: Number(port),
        method: "POST",
        headers: { "Content-Type": "text/xml;charset=utf-8", "Content-Length": Buffer.byteLength(xml, "utf8") },
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

async function main() {
  console.log("=== connectivity ===");
  const c = escapeXmlText(company);
  const companyXml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Company</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  let companyRes;
  try {
    companyRes = await tallyPost(companyXml, 20_000);
  } catch (e) {
    console.log(JSON.stringify({ result: "METADATA ROUND-TRIP BLOCKED", reason: "tally_http_unreachable", message: e.message }));
    process.exit(1);
  }
  const companyOk = companyRes.text.includes('NAME="PesoWise Integration Test"') || companyRes.text.includes(">PesoWise Integration Test<");
  console.log("endpoint_http", companyRes.status, "exact_company", companyOk);
  if (!companyOk) {
    console.log(JSON.stringify({ result: "METADATA ROUND-TRIP BLOCKED", reason: "tally_or_company_check_failed" }));
    process.exit(1);
  }

  const vchTypeInner = `<TALLYMESSAGE><VOUCHERTYPE ACTION="Create"><NAME>PesoWise Report Meta</NAME><PARENT>Journal</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></TALLYMESSAGE>`;
  const vchTypeXml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>${vchTypeInner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const vt = await tallyPost(vchTypeXml);
  const vtParsed = parseTallyImportResponse(vt.text);
  console.log(
    "ensure_voucher_type",
    "created",
    vtParsed.created,
    "altered",
    vtParsed.altered,
    "ok",
    vtParsed.ok,
    "exceptions",
    /EXCEPTIONS[^>]*>(\d+)/i.exec(vt.text)?.[1],
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
  const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260406</DATE><NARRATION>${escapeXmlText(`Phase51 metadata ${token}`)}</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">${escapeXmlText(metaJson)}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`;
  const importXml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  console.log("\n=== import ===");
  const imp = await tallyPost(importXml);
  const parsed = parseTallyImportResponse(imp.text);
  const created = parsed.created;
  const altered = parsed.altered;
  const exceptions = /EXCEPTIONS[^>]*>(\d+)/i.exec(imp.text)?.[1] ?? "?";
  const lineErrors = [...imp.text.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);
  console.log("http", imp.status, "created", created, "altered", altered, "exceptions", exceptions, "lineErrors", lineErrors);
  console.log("parsed_ok", parsed.ok, "errors", parsed.errors);
  console.log("response_excerpt", imp.text.slice(0, 500));

  const importPass =
    imp.status === 200 &&
    lineErrors.length === 0 &&
    Number(exceptions) === 0 &&
    (created >= 1 || altered >= 1) &&
    parsed.ok;

  if (!importPass) {
    console.log(
      JSON.stringify({
        result: "METADATA ROUND-TRIP BLOCKED",
        stage: "import",
        created,
        altered,
        exceptions,
        lineErrors,
      }),
    );
    process.exit(1);
  }

  console.log("\n=== readback ===");
  const exportAttempts = [
    {
      name: "collection_voucher_april",
      xml: `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VOUCHER</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20260430</SVTODATE><SVVOUCHERTYPE>PesoWise Report Meta</SVVOUCHERTYPE></STATICVARIABLES></DESC></BODY></ENVELOPE>`,
    },
    {
      name: "collection_voucher_all",
      xml: `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20260430</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`,
    },
  ];

  let readJson = null;
  let readSource = null;
  for (const attempt of exportAttempts) {
    const ex = await tallyPost(attempt.xml);
    const hasNarr = ex.text.includes(token);
    const udf = extractUdfJson(ex.text);
    console.log(attempt.name, "http", ex.status, "has_narration_token", hasNarr, "udf_found", !!udf);
    if (udf && (hasNarr || udf.includes(token))) {
      readJson = udf;
      readSource = attempt.name;
      break;
    }
    if (!udf && ex.text.includes("PESOWISE_METADATA_JSON")) {
      readJson = extractUdfJson(ex.text);
      if (readJson) readSource = attempt.name;
    }
  }

  if (!readJson) {
    console.log(JSON.stringify({ result: "METADATA ROUND-TRIP BLOCKED", stage: "readback", reason: "udf_not_found_in_export" }));
    process.exit(1);
  }

  let readObj;
  let sentObj;
  try {
    readObj = JSON.parse(readJson);
    sentObj = payload;
  } catch (e) {
    console.log(JSON.stringify({ result: "METADATA ROUND-TRIP BLOCKED", stage: "readback", reason: "invalid_json", read_excerpt: readJson.slice(0, 200) }));
    process.exit(1);
  }

  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const match = deepEqual(readObj, sentObj);

  console.log("read_source", readSource);
  console.log("json_match", match);
  if (!match) {
    console.log("sent", JSON.stringify(sentObj));
    console.log("read", JSON.stringify(readObj));
  }

  if (match) {
    console.log(JSON.stringify({ result: "METADATA ROUND-TRIP PASS", token, read_source: readSource }));
    process.exit(0);
  }
  console.log(JSON.stringify({ result: "METADATA ROUND-TRIP BLOCKED", stage: "compare", token }));
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  console.log(JSON.stringify({ result: "METADATA ROUND-TRIP BLOCKED", stage: "exception", message: e.message }));
  process.exit(1);
});
