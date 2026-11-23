import http from "http";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const c = "PesoWise Integration Test".replace(/&/g, "&amp;");

function post(inner) {
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

for (const parent of ["Journal", "Payment", "Sales", "Not Applicable"]) {
  const t = await post(
    `<TALLYMESSAGE><VOUCHERTYPE ACTION="Create"><NAME>PesoWise Report Meta</NAME><PARENT>${parent}</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></TALLYMESSAGE>`,
  );
  const p = parseTallyImportResponse(t);
  const le = [...t.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);
  console.log(parent, { ok: p.ok, created: p.created, exc: /EXCEPTIONS[^>]*>(\d+)/i.exec(t)?.[1], le, len: t.length, body: t.slice(0, 300) });
}
