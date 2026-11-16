const company = "PesoWise Integration Test";
const c = company.replace(/&/g, "&amp;");

async function exportCollection(id) {
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  const text = await fetch("http://127.0.0.1:9000", {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: xml,
  }).then((r) => r.text());
  return text;
}

for (const id of ["Ledger", "Voucher Type"]) {
  const t = await exportCollection(id);
  console.log("\n===", id, "size", t.length, "===");
  for (const needle of [
    "PW-SYNTH-TEST-MASTER",
    "PW-SYNTH-CAT",
    "PesoWise Expense",
    "PesoWise Report Meta",
    "PESOWISE_METADATA",
  ]) {
    console.log(needle, t.includes(needle));
  }
}
