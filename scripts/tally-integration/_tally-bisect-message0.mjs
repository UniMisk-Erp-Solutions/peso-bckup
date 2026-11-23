#!/usr/bin/env node
import { readFileSync } from "fs";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const raw = readFileSync("batch-debug-message0.xml", "utf-8");

async function post(inner) {
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml;charset=utf-8" }, body: xml });
  return parseTallyImportResponse(await res.text());
}

const name = "PW-META-BISECT-TEST-" + Date.now().toString(36);
const minimal = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create"><NAME.LIST><NAME>${name}</NAME></NAME.LIST><PARENT>PesoWise Metadata</PARENT><UDF:PESOWISE_METADATA_JSON TYPE="String">${esc('{"x":1}')}</UDF:PESOWISE_METADATA_JSON></LEDGER></TALLYMESSAGE>`;
console.log("minimal new name", await post(minimal));

const renamed = raw.replace("PW-META-39f9f0738e1d-10087be7bcd2", name + "-full");
console.log("full xml new name", await post(renamed));

console.log("original name retry", await post(raw));
