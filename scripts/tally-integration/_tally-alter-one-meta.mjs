#!/usr/bin/env node
const company = "PesoWise Integration Test";
const name = process.argv[2] ?? "PW-META-000592e0eb13-0e02621050c5";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Alter">
<NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST>
<UDF:PESOWISE_REPORT_TYPE TYPE="String">daily_project_report</UDF:PESOWISE_REPORT_TYPE>
<UDF:PESOWISE_REPORT_FLAT_ROW TYPE="String">01-01-2026|1|TEST|Test Proj|Emp|1|Loc|Rem|10||||||||50</UDF:PESOWISE_REPORT_FLAT_ROW>
</LEDGER></TALLYMESSAGE>`;
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const text = await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml" }, body: xml }).then((r) => r.text());
console.log(text);
