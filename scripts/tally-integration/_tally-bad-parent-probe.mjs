#!/usr/bin/env node
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const name = `PW-BAD-${Date.now().toString(36).slice(-4)}`;
const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create"><NAME.LIST><NAME>${name}</NAME></NAME.LIST><PARENT>No Such Group XYZ</PARENT><UDF:PESOWISE_METADATA_JSON TYPE="String">${esc("{}")}</UDF:PESOWISE_METADATA_JSON></LEDGER></TALLYMESSAGE>`;
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const text = await (await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml;charset=utf-8" }, body: xml })).text();
console.log(parseTallyImportResponse(text));
console.log(text);
