import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const company = "PesoWise Integration Test";
const c = company.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function post(body, report = "All Masters") {
  const xml = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const text = await fetch("http://127.0.0.1:9000", { method: "POST", headers: { "Content-Type": "text/xml" }, body: xml }).then(
    (r) => r.text(),
  );
  const p = parseTallyImportResponse(text);
  const exc = /EXCEPTIONS[^>]*>(\d+)/i.exec(text)?.[1];
  const le = [...text.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);
  return { created: p.created, ok: p.ok, exc, le, snippet: text.slice(0, 400) };
}

const variants = [
  ["vch_only", `<TALLYMESSAGE><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260406</DATE><NARRATION>meta no udf</NARRATION></VOUCHER></TALLYMESSAGE>`],
  [
    "udf_prefix",
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260406</DATE><NARRATION>meta udf1</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">{&quot;a&quot;:1}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`,
  ],
  [
    "plain_tag",
    `<TALLYMESSAGE><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260406</DATE><NARRATION>meta udf2</NARRATION><PESOWISE_METADATA_JSON>{&quot;a&quot;:1}</PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`,
  ],
  [
    "voucher_report",
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260406</DATE><NARRATION>meta udf3</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">{&quot;a&quot;:1}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`,
    "Voucher",
  ],
];

for (const [name, inner, report] of variants) {
  const r = await post(inner, report ?? "All Masters");
  console.log(name, report ?? "All Masters", r);
}
