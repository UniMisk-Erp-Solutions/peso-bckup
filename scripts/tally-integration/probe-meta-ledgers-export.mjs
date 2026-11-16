#!/usr/bin/env node
import http from "node:http";

const company = "PesoWise Integration Test";
const xml = `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>PWMetaLedgersProbe</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="PWMetaLedgersProbe" ISMODIFY="No"><TYPE>Ledger</TYPE><CHILDOF>"PesoWise Metadata"</CHILDOF>
        <FETCH>Name, PESOWISE_METADATA_JSON, PESOWISE_DPR_TRACK_DATE, PESOWISE_DPR_EMPLOYEE, PESOWISE_DPR_PROJECT_NAME</FETCH>
        <FILTERS>PWMetaName</FILTERS><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION>
      <SYSTEM TYPE="Formulae" NAME="PWMetaName">$$IsLedOfGrp:$Name:"PesoWise Metadata"</SYSTEM>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`;

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

const ledgers = [...body.matchAll(/<LEDGER[^>]*NAME="([^"]+)"/gi)].map((m) => m[1]);
console.log(JSON.stringify({
  bytes: body.length,
  ledger_count: ledgers.length,
  sample_names: ledgers.slice(0, 5),
  has_dpr_track: body.includes("PESOWISE_DPR_TRACK_DATE"),
  has_daily_json: body.includes("daily_project_report"),
  snippet: body.slice(body.indexOf("<LEDGER"), body.indexOf("<LEDGER") + 1200),
}, null, 2));
