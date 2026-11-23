#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const jobId = process.argv[2] ?? "f8363f03-db97-4d96-8f6c-3fccd6a3d66e";
const idx = Number(process.argv[3] ?? 0);
const company = process.argv[4] ?? "PesoWise Integration Test";
const pass = requireCoolifySshPassword();
const row = await sshPsqlJson(
  `SELECT jsonb_build_object('xml', xml_payload) FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND batch_index=${idx}`,
  { password: pass },
);
let xml = String(row?.xml ?? "");
if (!xml.includes("PesoWise Integration Test")) {
  const esc = company.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  xml = xml.replace(
    "<SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY>",
    `<SVCURRENTCOMPANY>${esc}</SVCURRENTCOMPANY>`,
  );
}
console.log("xml_bytes", Buffer.byteLength(xml, "utf8"), "messages", (xml.match(/<TALLYMESSAGE/g) || []).length);
const res = await fetch("http://127.0.0.1:9000", {
  method: "POST",
  headers: { "Content-Type": "text/xml;charset=utf-8" },
  body: xml,
});
const text = await res.text();
console.log(JSON.stringify(parseTallyImportResponse(text), null, 2));
if (!parseTallyImportResponse(text).ok) console.log(text.slice(0, 800));
