#!/usr/bin/env node
const company = "PesoWise Integration Test";
const name = process.argv[2] ?? "PW-META-000592e0eb13-0e02621050c5";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><SUBTYPE>Ledger</SUBTYPE><ID TYPE="Name">${esc(name)}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
const text = await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml" }, body: xml }).then((r) => r.text());
console.log("bytes", text.length);
const parent = text.match(/<PARENT[^>]*>([^<]+)</i)?.[1] ?? text.match(/<PARENT\.TYPE>[^<]*<\/PARENT\.TYPE>\s*<PARENT>([^<]+)/i)?.[1];
const guid = text.match(/<GUID[^>]*>([^<]+)/i)?.[1];
console.log({ parent, guid: guid?.slice(0, 36) });
console.log(text.slice(0, 2500));
