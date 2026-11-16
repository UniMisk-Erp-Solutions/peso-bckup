#!/usr/bin/env node
import http from "http";

const company = "PesoWise Integration Test";
const ledger = process.argv[2] ?? "PW-META-04fd0f3a4fa1";
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><SUBTYPE>Ledger</SUBTYPE><ID TYPE="Name">${esc(ledger)}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;

const timeoutMs = Number(process.env.TALLY_EXPORT_TIMEOUT_MS ?? "20000");

const req = http.request(
  {
    host: "127.0.0.1",
    port: 9000,
    method: "POST",
    timeout: timeoutMs,
    headers: { "Content-Type": "text/xml", "Content-Length": Buffer.byteLength(xml) },
  },
  (res) => {
    const chunks = [];
    res.on("data", (d) => chunks.push(d));
    res.on("end", () => process.stdout.write(Buffer.concat(chunks).toString("utf8")));
  },
);
req.on("timeout", () => req.destroy(new Error(`export_timeout_${timeoutMs}ms`)));
req.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});
req.write(xml);
req.end();
