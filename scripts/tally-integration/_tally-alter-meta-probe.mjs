#!/usr/bin/env node
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const name = "PW-META-39f9f0738e1d-10087be7bcd2";
const json = esc(JSON.stringify({ report_type: "daily_project_report", probe: "alter" }));
const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Alter">
<NAME.LIST><NAME>${name}</NAME></NAME.LIST>
<UDF:PESOWISE_METADATA_JSON TYPE="String">${json}</UDF:PESOWISE_METADATA_JSON>
</LEDGER></TALLYMESSAGE>`;
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const res = await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml;charset=utf-8" }, body: xml });
console.log(parseTallyImportResponse(await res.text()));
