#!/usr/bin/env node
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const name = `PW-META-EMPTY-${Date.now().toString(36).slice(-4)}`;

async function post(label, inner) {
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await fetch("http://127.0.0.1:9000", {
    method: "POST",
    headers: { "Content-Type": "text/xml;charset=utf-8" },
    body: xml,
  });
  const parsed = parseTallyImportResponse(await res.text());
  console.log(label, { ok: parsed.ok, created: parsed.created, exceptions: parsed.rawExcerpt.match(/EXCEPTIONS>(\d+)/)?.[1] });
}

const minimal = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create"><NAME.LIST><NAME>${name}</NAME></NAME.LIST><PARENT>PesoWise Metadata</PARENT><UDF:PESOWISE_METADATA_JSON TYPE="String">${esc("{}")}</UDF:PESOWISE_METADATA_JSON></LEDGER></TALLYMESSAGE>`;

const withEmpty = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create"><NAME.LIST><NAME>${name}-e</NAME></NAME.LIST><PARENT>PesoWise Metadata</PARENT>
<UDF:PESOWISE_DPR_MATERIAL_COST TYPE="String"></UDF:PESOWISE_DPR_MATERIAL_COST>
<UDF:PESOWISE_METADATA_JSON TYPE="String">${esc("{}")}</UDF:PESOWISE_METADATA_JSON></LEDGER></TALLYMESSAGE>`;

await post("minimal", minimal);
await post("empty udf tag", withEmpty);
