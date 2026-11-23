import http from "http";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const c = company.replace(/&/g, "&amp;");

function post(xml) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 9000, method: "POST", headers: { "Content-Type": "text/xml" } }, (res) => {
      const ch = [];
      res.on("data", (d) => ch.push(d));
      res.on("end", () => resolve(Buffer.concat(ch).toString("utf8")));
    });
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function imp(inner) {
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 9000, method: "POST", headers: { "Content-Type": "text/xml" } }, (res) => {
      const ch = [];
      res.on("data", (d) => ch.push(d));
      res.on("end", () => resolve(Buffer.concat(ch).toString("utf8")));
    });
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function summarize(label, t) {
  const p = parseTallyImportResponse(t);
  const le = [...t.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);
  console.log(label, {
    serverRunning: t.includes("TallyPrime Server is Running"),
    ok: p.ok,
    created: p.created,
    exc: /EXCEPTIONS[^>]*>(\d+)/i.exec(t)?.[1],
    le,
  });
}

const wake = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Company</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
console.log("wake_len", (await post(wake)).length);

const steps = [
  ["expense_vt", `<TALLYMESSAGE><VOUCHERTYPE ACTION="Create"><NAME>PesoWise Expense</NAME><PARENT>Payment</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></TALLYMESSAGE>`],
  ["report_meta_vt", `<TALLYMESSAGE><VOUCHERTYPE ACTION="Create"><NAME>PesoWise Report Meta</NAME><PARENT>Journal</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></TALLYMESSAGE>`],
  ["meta_vch", `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260406</DATE><NARRATION>meta after bootstrap</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">{&quot;schema_version&quot;:1,&quot;note&quot;:&quot;Unicode \u0928\u094b\u091f&quot;,&quot;amp&quot;:&quot;A &amp; B&quot;,&quot;lt&quot;:&quot;&lt;t&gt;&quot;,&quot;gt&quot;:&quot;&gt;x&lt;&quot;,&quot;quotes&quot;:&quot;\\&quot;double\\&quot;&quot;,&quot;nl&quot;:&quot;line1\\nline2&quot;,&quot;nested&quot;:{&quot;k&quot;:&quot;v&quot;}}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`],
];

for (const [label, inner] of steps) {
  summarize(label, await imp(inner));
}
