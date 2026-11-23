#!/usr/bin/env node
import http from "node:http";

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

const listXml = `<?xml version="1.0"?>
<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>List of Companies</ID></HEADER>
<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;

const body = await post(listXml);
const names = [...body.matchAll(/<NAME[^>]*>([^<]+)</gi)].map((m) => m[1].trim());
console.log(JSON.stringify({ bytes: body.length, companies: names.slice(0, 20), snippet: body.slice(0, 400) }, null, 2));
