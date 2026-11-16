#!/usr/bin/env node
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const jobId = process.argv[2];
const idx = Number(process.argv[3] ?? 0);
const company = process.argv[4] ?? "PesoWise Integration Test";
if (!jobId) {
  console.error("Usage: node _split-batch-post.mjs <job_id> [batch_index] [company]");
  process.exit(2);
}

const pass = requireCoolifySshPassword();
const row = await sshPsqlJson(
  `SELECT jsonb_build_object('xml', xml_payload) FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND batch_index=${idx}`,
  { password: pass },
);
let xml = String(row?.xml ?? "");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
xml = xml.replace(
  "<SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY>",
  `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>`,
);
const parts = xml.split(/(?=<TALLYMESSAGE)/i).filter((p) => p.includes("TALLYMESSAGE"));
console.log("messages", parts.length);
for (let i = 0; i < parts.length; i++) {
  const inner = parts[i].trim();
  const one = `<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${inner}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const res = await fetch("http://127.0.0.1:9000", {
    method: "POST",
    headers: { "Content-Type": "text/xml;charset=utf-8" },
    body: one,
  });
  const text = await res.text();
  const parsed = parseTallyImportResponse(text);
  const name = inner.match(/<NAME>([^<]+)<\/NAME>/)?.[1] ?? inner.slice(0, 60);
  console.log(i, name, {
    ok: parsed.ok,
    created: parsed.created,
    exc: text.match(/<EXCEPTIONS>(\d+)/)?.[1],
  });
}
