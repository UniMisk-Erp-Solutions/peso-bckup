#!/usr/bin/env node
import http from "node:http";

const company = "PesoWise Integration Test";
const name = process.argv[2] ?? "PW-META-39f9f0738e1d-10087be7bcd2";
const xml = `<?xml version="1.0"?>
<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><SUBTYPE>Ledger</SUBTYPE><ID TYPE="Name">${name}</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;

const body = await new Promise((resolve, reject) => {
  const req = http.request(
    { host: "127.0.0.1", port: 9000, method: "POST", headers: { "Content-Type": "text/xml" } },
    (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    },
  );
  req.on("error", reject);
  req.write(xml);
  req.end();
});
console.log("bytes", body.length);
console.log(body.includes("PESOWISE_REPORT_FLAT_ROW") ? "has_flat_row" : "no_flat_row");
console.log(body.slice(0, 1500));
