#!/usr/bin/env node
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const name = `PW-META-FULL-${Date.now().toString(36).slice(-4)}`;
const json = esc(JSON.stringify({ report_type: "daily_project_report", test: true }));
const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create">
<NAME.LIST><NAME>${name}</NAME></NAME.LIST>
<PARENT>PesoWise Metadata</PARENT>
<UDF:PESOWISE_STABLE_KEY TYPE="String">stable-key-test</UDF:PESOWISE_STABLE_KEY>
<UDF:PW_DAILY_DATE TYPE="String">2026-09-02</UDF:PW_DAILY_DATE>
<UDF:PESOWISE_METADATA_JSON TYPE="String">${json}</UDF:PESOWISE_METADATA_JSON>
</LEDGER></TALLYMESSAGE>`;
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const res = await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml;charset=utf-8" }, body: xml });
console.log(name, parseTallyImportResponse(await res.text()));
