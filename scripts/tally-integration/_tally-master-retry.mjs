import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const c = company.replace(/&/g, "&amp;");
const name = `PW-SYNTH-MASTER-${Date.now().toString(36).slice(-6)}`;

const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create"><NAME.LIST><NAME>${name}</NAME></NAME.LIST><PARENT>PesoWise Expenses</PARENT><UDF:PESOWISE_STABLE_KEY TYPE="String">micro-test:${name}</UDF:PESOWISE_STABLE_KEY></LEDGER></TALLYMESSAGE>`;
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

const text = await fetch("http://127.0.0.1:9000", {
  method: "POST",
  headers: { "Content-Type": "text/xml" },
  body: xml,
}).then((r) => r.text());
const parsed = parseTallyImportResponse(text);
console.log({ name, ok: parsed.ok, parsed, text });
