#!/usr/bin/env node
import fs from "node:fs";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const file = process.argv[2];
const company = process.argv[3] ?? "PesoWise Integration Test";
if (!file) {
  console.error("Usage: node _import-xml-file-once.mjs <inner-or-envelope.xml> [company]");
  process.exit(2);
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let body = fs.readFileSync(file, "utf8");
if (!body.includes("<ENVELOPE")) {
  body = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
const res = await fetch("http://127.0.0.1:9000", {
  method: "POST",
  headers: { "Content-Type": "text/xml;charset=utf-8" },
  body,
});
const text = await res.text();
console.log(JSON.stringify(parseTallyImportResponse(text), null, 2));
console.log(text.slice(0, 1200));
