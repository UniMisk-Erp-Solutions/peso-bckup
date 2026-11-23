#!/usr/bin/env node
import http from "node:http";

const company = "PesoWise Integration Test";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const name = `PW-PROBE-${Date.now().toString(36)}`;

function post(inner) {
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: 9000, method: "POST", headers: { "Content-Type": "text/xml" }, timeout: 15000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(xml);
    req.end();
  });
}

const plain = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create"><NAME.LIST><NAME>${name}</NAME></NAME.LIST><PARENT>PesoWise Metadata</PARENT><UDF:PESOWISE_METADATA_JSON TYPE="String">${esc('{"report_type":"daily_project_report","probe":true}')}</UDF:PESOWISE_METADATA_JSON></LEDGER></TALLYMESSAGE>`;

const r = await post(plain);
console.log(JSON.stringify({ name, bytes: r.length, response: r.slice(0, 800) }, null, 2));
