#!/usr/bin/env node
/** Read-only Tally probes — no imports. */
const host = process.env.TALLY_HOST ?? "127.0.0.1";
const port = process.env.TALLY_PORT ?? "9000";

const probes = [
  ["export_license", `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>LicenseInfo</ID></HEADER></ENVELOPE>`],
  ["export_active_company", `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Company</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>`],
];

for (const [name, xml] of probes) {
  const res = await fetch(`http://${host}:${port}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml;charset=utf-8" },
    body: xml,
  });
  const text = await res.text();
  console.log("\n===", name, "HTTP", res.status, "===");
  console.log(text.slice(0, 2000));
}
