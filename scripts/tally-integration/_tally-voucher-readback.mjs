const company = "PesoWise Integration Test";
const c = company.replace(/&/g, "&amp;");
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>VOUCHER</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20260401</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
const t = await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml" }, body: xml }).then(
  (r) => r.text(),
);
console.log("has Synthetic micro test", t.includes("Synthetic micro test"));
console.log("has PW-SYNTH-CAT", t.includes("PW-SYNTH-CAT"));
console.log("excerpt:", t.slice(0, 1500));
