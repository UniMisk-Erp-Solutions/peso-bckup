#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";
import { sshPsqlJson } from "./_sshPsqlRemote.mjs";
import { requireCoolifySshPassword } from "./_coolifySshCredentials.mjs";

const jobId = process.argv[2];
const batchIndex = Number(process.argv[3] ?? 3);
const pass = requireCoolifySshPassword();
const batchRow = await sshPsqlJson(
  `SELECT jsonb_build_object('id', id::text) FROM tally_sync_delivery_batches WHERE job_id='${jobId}' AND batch_index=${batchIndex};`,
  { password: pass },
);
const batchId = batchRow.id;
const cfg = JSON.parse(readFileSync(join(homedir(), "PesoWise/TallyConnector/config.json"), "utf-8"));
const url = cfg.pesoApiUrl.replace(/\/$/, "") + "/functions/v1/tally-connector";
const claimRes = await fetch(url, {
  method: "POST",
  headers: { Authorization: `Bearer ${cfg.deviceToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({ action: "claim", job_id: jobId, batch_id: batchId, lease_seconds: 120 }),
});
const claim = await claimRes.json();
if (!claim.claimed) {
  console.error("claim failed", claim);
  process.exit(1);
}
const company = claim.tally_company_name || cfg.tallyCompanyName;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const xml = claim.xml.replace(
  "<SVCURRENTCOMPANY><!-- configured at connector time --></SVCURRENTCOMPANY>",
  `<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>`,
);
const parts = xml.split(/(?=<TALLYMESSAGE)/i).filter((p) => p.includes("TALLYMESSAGE"));
console.log("messages", parts.length);
if (parts[0]) writeFileSync("batch-debug-message0.xml", parts[0], "utf-8");
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
  const name = inner.match(/<NAME>([^<]+)<\/NAME>/)?.[1] ?? inner.slice(0, 80);
  console.log(i, name, parsed);
  if (!parsed.ok) console.log(text.slice(0, 800));
}
