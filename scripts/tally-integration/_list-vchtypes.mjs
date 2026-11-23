import http from "http";
const company = "PesoWise Integration Test";
const c = company.replace(/&/g, "&amp;");
const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Voucher Type</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
const text = await new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port: 9000, method: "POST", headers: { "Content-Type": "text/xml" } }, (res) => {
    const ch = [];
    res.on("data", (d) => ch.push(d));
    res.on("end", () => resolve(Buffer.concat(ch).toString("utf8")));
  });
  req.on("error", reject);
  req.write(xml);
  req.end();
});
console.log("response_len", text.length);
console.log("has Report Meta", text.includes("PesoWise Report Meta"));
console.log("has Journal", text.includes("Journal"));
console.log("has Payment", text.includes("Payment"));
const names = [...text.matchAll(/NAME="([^"]+)"/g)].map((m) => m[1]).filter((n) => /peso|journal|payment/i.test(n));
console.log("sample_names", [...new Set(names)].slice(0, 30));
