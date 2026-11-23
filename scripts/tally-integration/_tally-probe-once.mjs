const company = "PesoWise Integration Test";
const c = company.replace(/&/g, "&amp;");

async function postEnvelope(body) {
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return fetch("http://127.0.0.1:9000", {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: xml,
  }).then((r) => r.text());
}

const metaInner = `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260402</DATE><NARRATION>meta probe</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">{&quot;probe&quot;:true}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`;
console.log("=== metadata full response ===");
console.log(await postEnvelope(metaInner));

const masterInner = `<TALLYMESSAGE><LEDGER ACTION="Alter"><NAME.LIST><NAME>PW-SYNTH-TEST-MASTER</NAME></NAME.LIST><PARENT>PesoWise Expenses</PARENT></LEDGER></TALLYMESSAGE>`;
console.log("\n=== master alter ===");
console.log(await postEnvelope(masterInner));
