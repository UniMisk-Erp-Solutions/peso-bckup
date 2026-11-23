#!/usr/bin/env node
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = process.argv[2] ?? "PesoWise Integration Test";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const inner = `<TALLYMESSAGE><GROUP ACTION="Create"><NAME.LIST><NAME>PesoWise Metadata</NAME></NAME.LIST><PARENT>Primary</PARENT></GROUP></TALLYMESSAGE>`;
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const res = await fetch("http://127.0.0.1:9000", {
  method: "POST",
  headers: { "Content-Type": "text/xml;charset=utf-8" },
  body: xml,
});
const text = await res.text();
console.log(parseTallyImportResponse(text));
console.log(text);
