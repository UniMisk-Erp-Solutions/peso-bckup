#!/usr/bin/env node
/**
 * Phase 5.1 — ONE All Masters ledger import with golden UDF .LIST shape.
 */
import http from "http";
import { execSync } from "child_process";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";

const host = "127.0.0.1";
const port = 9000;
const timeoutMs = 15_000;
const company = "PesoWise Integration Test";
const ledgerName = "PW-META-HTTP-001";
const parentGroup = "PesoWise Metadata";

const payload = {
  probe: true,
  token: "PW-META-HTTP-001",
  source: "phase51_http_import",
};

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tallyProcessRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq tally.exe" /FO CSV /NH', { encoding: "utf8" });
    return out.toLowerCase().includes("tally.exe");
  } catch {
    return false;
  }
}

function portListening() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Test-NetConnection -ComputerName ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded"`,
      { encoding: "utf8", timeout: 12_000 },
    ).trim();
    return out === "True";
  } catch {
    return false;
  }
}

function buildEnvelope() {
  const c = escapeXmlText(company);
  const name = escapeXmlText(ledgerName);
  const parent = escapeXmlText(parentGroup);
  const json = escapeXmlText(JSON.stringify(payload));
  const inner = `<TALLYMESSAGE xmlns:UDF="TallyUDF">
  <LEDGER ACTION="Create">
    <NAME.LIST><NAME>${name}</NAME></NAME.LIST>
    <PARENT>${parent}</PARENT>
    <UDF:PESOWISE_METADATA_JSON.LIST DESC="PESOWISE_METADATA_JSON" ISLIST="YES" TYPE="String" INDEX="25001">
      <UDF:PESOWISE_METADATA_JSON DESC="PESOWISE_METADATA_JSON">${json}</UDF:PESOWISE_METADATA_JSON>
    </UDF:PESOWISE_METADATA_JSON.LIST>
  </LEDGER>
</TALLYMESSAGE>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${inner}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function tallyPost(xml) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request(
      {
        host,
        port,
        method: "POST",
        headers: {
          "Content-Type": "text/xml;charset=utf-8",
          "Content-Length": Buffer.byteLength(xml, "utf8"),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            elapsedMs: Date.now() - started,
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout_15s")));
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

const before = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
console.log("=== BEFORE ===");
console.log(JSON.stringify(before));

if (!before.tally_exe || !before.port_9000) {
  console.log(JSON.stringify({ final: "AUTOMATED LEDGER IMPORT FAILED — STOPPED SAFELY", reason: "tally_or_port_not_ready", before }));
  process.exit(1);
}

const envelope = buildEnvelope();
console.log("=== EXACT XML SENT (complete) ===");
console.log(envelope);

let resp;
try {
  resp = await tallyPost(envelope);
} catch (e) {
  const after = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
  console.log(JSON.stringify({ final: "AUTOMATED LEDGER IMPORT FAILED — STOPPED SAFELY", reason: e.message, before, after }));
  process.exit(1);
}

const after = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
const parsed = parseTallyImportResponse(resp.text);
const errorsTag = Number(/<ERRORS[^>]*>(\d+)/i.exec(resp.text)?.[1] ?? -1);
const exceptionsTag = Number(/<EXCEPTIONS[^>]*>(\d+)/i.exec(resp.text)?.[1] ?? -1);
const lineErrors = [...resp.text.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);

console.log("=== AFTER ===");
console.log(JSON.stringify(after));
console.log("=== RESPONSE META ===");
console.log(
  JSON.stringify({
    http_status: resp.status,
    elapsed_ms: resp.elapsedMs,
    CREATED: parsed.created,
    ALTERED: parsed.altered,
    ERRORS: errorsTag,
    EXCEPTIONS: exceptionsTag,
    LINEERROR: lineErrors,
    LASTMID: parsed.lastMid,
  }),
);
console.log("=== EXACT TALLY RESPONSE (complete) ===");
console.log(resp.text);

if (!after.tally_exe || !after.port_9000) {
  console.log(JSON.stringify({ final: "AUTOMATED LEDGER IMPORT FAILED — STOPPED SAFELY", reason: "tally_or_port_down_after", before, after }));
  process.exit(1);
}

const pass =
  parsed.created >= 1 && errorsTag === 0 && exceptionsTag === 0 && lineErrors.length === 0;

if (!pass) {
  console.log(JSON.stringify({ final: "AUTOMATED LEDGER IMPORT FAILED — STOPPED SAFELY", before, after }));
  process.exit(1);
}

console.log(
  JSON.stringify({
    final: "AUTOMATED LEDGER IMPORT PASS — READY FOR MANUAL LEDGER XML EXPORT",
    ledger: ledgerName,
    before,
    after,
    elapsed_ms: resp.elapsedMs,
    manual_step:
      "Alter PW-META-HTTP-001, confirm UDF JSON, export Ledgers XML, verify INDEX=25001 and token PW-META-HTTP-001",
  }),
);
