#!/usr/bin/env node
/** Ledgers in the company currently active on Tally HTTP (no SVCURRENTCOMPANY). */
const xml = `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Ledgers</ID></HEADER>
  <BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY>
</ENVELOPE>`;
const text = await fetch("http://127.0.0.1:9000", {
  method: "POST",
  headers: { "Content-Type": "text/xml;charset=utf-8" },
  body: xml,
  signal: AbortSignal.timeout(120_000),
}).then((r) => r.text());
const idle = /TallyPrime Server is Running/i.test(text) && !/LEDGER|COLLECTION/i.test(text);
const names = [...text.matchAll(/<LEDGER[^>]*NAME="([^"]+)"/gi)].map((m) => m[1]);
const meta = names.filter((n) => n.includes("PW-META") || n.includes("PesoWise"));
console.log(
  JSON.stringify(
    {
      idle,
      bytes: text.length,
      ledger_count: names.length,
      meta_ledger_count: meta.length,
      meta_samples: meta.slice(0, 8),
      all_samples: names.slice(0, 15),
    },
    null,
    2,
  ),
);
