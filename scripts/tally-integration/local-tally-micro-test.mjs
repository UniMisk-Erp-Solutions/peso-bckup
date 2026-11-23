#!/usr/bin/env node
/**
 * Localhost Tally micro probes (no secrets). Usage:
 *   node scripts/tally-integration/local-tally-micro-test.mjs [companyName]
 */
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const host = process.env.TALLY_HOST ?? "127.0.0.1";
const port = process.env.TALLY_PORT ?? "9000";
const company = process.argv[2] ?? "PesoWise Integration Test";

async function post(xml) {
  const res = await fetch(`http://${host}:${port}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml;charset=utf-8" },
    body: xml,
  });
  const text = await res.text();
  return { status: res.status, text, parsed: parseTallyImportResponse(text) };
}

function wrapCompany(inner, co) {
  const c = co.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
<REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

function summarize(label, r) {
  console.log(
    label,
    "HTTP",
    r.status,
    "ok=",
    r.parsed.ok,
    "created=",
    r.parsed.created,
    "altered=",
    r.parsed.altered,
    "errors=",
    r.parsed.errors,
  );
  if (!r.parsed.ok) console.log(r.text.slice(0, 600));
  return r.parsed.ok;
}

console.log("Tally endpoint:", `http://${host}:${port}`);
console.log("Company target:", company);

const bootstrap = [
  [
    "bootstrap_group",
    wrapCompany(
      `<TALLYMESSAGE><GROUP ACTION="Create"><NAME.LIST><NAME>PesoWise Expenses</NAME></NAME.LIST><PARENT>Direct Expenses</PARENT></GROUP></TALLYMESSAGE>`,
      company,
    ),
  ],
  [
    "bootstrap_vch_expense",
    wrapCompany(
      `<TALLYMESSAGE><VOUCHERTYPE ACTION="Create"><NAME>PesoWise Expense</NAME><PARENT>Payment</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></TALLYMESSAGE>`,
      company,
    ),
  ],
  [
    "bootstrap_vch_meta",
    wrapCompany(
      `<TALLYMESSAGE><VOUCHERTYPE ACTION="Create"><NAME>PesoWise Report Meta</NAME><PARENT>Journal</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></TALLYMESSAGE>`,
      company,
    ),
  ],
  [
    "bootstrap_led_cat",
    wrapCompany(
      `<TALLYMESSAGE><LEDGER ACTION="Create"><NAME.LIST><NAME>PW-SYNTH-CAT</NAME></NAME.LIST><PARENT>PesoWise Expenses</PARENT></LEDGER></TALLYMESSAGE>`,
      company,
    ),
  ],
  [
    "bootstrap_led_emp",
    wrapCompany(
      `<TALLYMESSAGE><LEDGER ACTION="Create"><NAME.LIST><NAME>PW-SYNTH-EMP</NAME></NAME.LIST><PARENT>Current Liabilities</PARENT></LEDGER></TALLYMESSAGE>`,
      company,
    ),
  ],
];

for (const [label, xml] of bootstrap) {
  console.log("\n===", label, "===");
  summarize(label, await post(xml));
}

const masterName = `PW-SYNTH-MASTER-${Date.now().toString(36).slice(-6)}`;
const master = wrapCompany(
  `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER ACTION="Create"><NAME.LIST><NAME>${masterName}</NAME></NAME.LIST><PARENT>PesoWise Expenses</PARENT><UDF:PESOWISE_STABLE_KEY TYPE="String">micro:${masterName}</UDF:PESOWISE_STABLE_KEY></LEDGER></TALLYMESSAGE>`,
  company,
);

const voucher = wrapCompany(
  `<TALLYMESSAGE><VOUCHER ACTION="Create" VCHTYPE="PesoWise Expense"><DATE>20260401</DATE><NARRATION>Synthetic micro test</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>PW-SYNTH-CAT</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>PW-SYNTH-EMP</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>`,
  company,
);

const metaJson = JSON.stringify({
  schema_version: 1,
  report_type: "claim_verification",
  fields: {
    note: "Unicode नोट",
    amp: "A & B",
    lt: "<tag>",
    gt: ">x<",
    quotes: '"double"',
    nl: "line1\nline2",
    nested: { k: "v" },
  },
});
const metaEsc = metaJson
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");
const metadata = wrapCompany(
  `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260401</DATE><NARRATION>meta test</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">${metaEsc}</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>`,
  company,
);

let masterOk = false;
let voucherOk = false;
let metaOk = false;

for (const [label, xml] of [
  ["master", master],
  ["voucher", voucher],
  ["metadata", metadata],
]) {
  console.log("\n===", label, "===");
  const ok = summarize(label, await post(xml));
  if (label === "master") masterOk = ok;
  if (label === "voucher") voucherOk = ok;
  if (label === "metadata") metaOk = ok;
}

console.log("\n=== SUMMARY ===", { masterOk, voucherOk, metaOk });
