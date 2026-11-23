#!/usr/bin/env node
import http from "node:http";

const company = "PesoWise Integration Test";

function post(xml) {
  return new Promise((resolve, reject) => {
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
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// All ledgers under PesoWise Metadata (no JSON filter)
const xml1 = `<?xml version="1.0"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWDiagMeta</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="PWDiagMeta"><TYPE>Ledger</TYPE><CHILDOF>"PesoWise Metadata"</CHILDOF><FETCH>Name</FETCH><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

// Ledgers whose name contains PW-META anywhere in company
const xml2 = `<?xml version="1.0"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWDiagName</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="PWDiagName"><TYPE>Ledger</TYPE><FETCH>Name</FETCH><FILTERS>PWNameFilter</FILTERS><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="PWNameFilter">$$StringContains:$Name:"PW-META"</SYSTEM>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;

const b1 = await post(xml1);
const b2 = await post(xml2);
const names1 = [...b1.matchAll(/<LEDGER[^>]*NAME="([^"]+)"/gi)].map((m) => m[1]);
const names2 = [...b2.matchAll(/<LEDGER[^>]*NAME="([^"]+)"/gi)].map((m) => m[1]);
console.log(
  JSON.stringify(
    {
      under_pesowise_metadata_group: names1.length,
      sample_group: names1.slice(0, 5),
      name_contains_pw_meta: names2.length,
      sample_name: names2.slice(0, 5),
      raw_hint: b1.slice(0, 120),
    },
    null,
    2,
  ),
);
