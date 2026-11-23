#!/usr/bin/env node
const company = "PesoWise Integration Test";
const xml = `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Ledgers</ID></HEADER>
  <BODY><DESC><STATICVARIABLES>
    <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
  </STATICVARIABLES></DESC></BODY>
</ENVELOPE>`;
const text = await fetch("http://127.0.0.1:9000", {
  method: "POST",
  headers: { "Content-Type": "text/xml;charset=utf-8" },
  body: xml,
}).then((r) => r.text());
const all = [...text.matchAll(/NAME="([^"]+)"/g)].map((m) => m[1]);
const meta = all.filter((n) => n.includes("PW-META") || n.includes("PW-PREFLIGHT") || n.includes("PesoWise"));
console.log(JSON.stringify({ bytes: text.length, total_ledgers: all.length, meta_like: meta.length, samples: meta.slice(0, 8), head: text.slice(0, 200) }, null, 2));
