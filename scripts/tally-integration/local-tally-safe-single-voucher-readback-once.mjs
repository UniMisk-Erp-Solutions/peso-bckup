#!/usr/bin/env node
/**
 * Phase 5.1 — EXACTLY ONE bounded Object export for Payment #3 UDF readback.
 * No Collection VOUCHER, no Day Book, no import, no retry.
 */
import http from "http";
import { execSync } from "child_process";

const host = "127.0.0.1";
const port = 9000;
const timeoutMs = 15_000;
const company = "PesoWise Integration Test";
const token = "PW-META-BAL-mwbu7q3";
const expectedNarration = `Phase51 balanced meta ${token}`;

const expectedPayload = {
  schema_version: 1,
  report_type: "claim_verification",
  roundtrip_token: token,
  fields: {
    ascii: "plain ASCII",
    note: "Unicode नोट",
    amp: "A & B",
    lt: "<tag>",
    gt: ">x<",
    quotes: '"double"',
    nl: "line1\nline2",
    nested: { k: "v", n: 1 },
  },
};

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXmlText(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
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
    execSync(
      `powershell -NoProfile -Command "(Test-NetConnection -ComputerName ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded"`,
      { encoding: "utf8", timeout: 10_000 },
    );
    const out = execSync(
      `powershell -NoProfile -Command "(Test-NetConnection -ComputerName ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded"`,
      { encoding: "utf8", timeout: 10_000 },
    ).trim();
    return out === "True";
  } catch {
    return false;
  }
}

function buildObjectExportXml() {
  const c = escapeXmlText(company);
  // Bounded single voucher: UI-resolved type Payment + voucher number + single day.
  // No Collection walk; explicit FETCH only; no ledger/inventory subgraph.
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Object</TYPE>
    <SUBTYPE>Voucher</SUBTYPE>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>20260406</SVFROMDATE>
        <SVTODATE>20260406</SVTODATE>
        <SVVOUCHERTYPE>Payment</SVVOUCHERTYPE>
        <SVVOUCHERNUMBER>3</SVVOUCHERNUMBER>
      </STATICVARIABLES>
      <FETCHLIST>
        <FETCH>Date</FETCH>
        <FETCH>VoucherTypeName</FETCH>
        <FETCH>VoucherNumber</FETCH>
        <FETCH>Narration</FETCH>
        <FETCH>MasterId</FETCH>
        <FETCH>AlterId</FETCH>
        <FETCH>GUID</FETCH>
        <FETCH>PESOWISE_METADATA_JSON</FETCH>
      </FETCHLIST>
    </DESC>
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
    req.on("timeout", () => {
      req.destroy(new Error("timeout_15s"));
    });
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function extractTag(xml, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "i");
    const m = xml.match(re);
    if (m) return decodeXmlText(m[1].trim());
  }
  return null;
}

function extractUdf(xml) {
  for (const re of [
    /<PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/PESOWISE_METADATA_JSON>/i,
    /<UDF:PESOWISE_METADATA_JSON[^>]*>([\s\S]*?)<\/UDF:PESOWISE_METADATA_JSON>/i,
  ]) {
    const m = xml.match(re);
    if (m) return decodeXmlText(m[1].trim());
  }
  return null;
}

const method =
  "TYPE=Object SUBTYPE=Voucher; STATICVARIABLES SVCURRENTCOMPANY + SVFROMDATE/SVTODATE=20260406 + SVVOUCHERTYPE=Payment + SVVOUCHERNUMBER=3; minimal FETCHLIST (no Collection VOUCHER); HEADER ID omitted";

console.log("=== STATIC METHOD ===");
console.log(method);

const before = {
  tally_exe: tallyProcessRunning(),
  port_9000: portListening(),
};
console.log("=== BEFORE ===");
console.log(JSON.stringify(before));

if (!before.port_9000) {
  console.log(
    JSON.stringify({
      final: "SAFE READBACK BLOCKED",
      reason: "port_9000_not_listening",
      before,
    }),
  );
  process.exit(1);
}

const exportXml = buildObjectExportXml();
console.log("=== REQUEST XML (no secrets) ===");
console.log(exportXml);

let resp;
try {
  resp = await tallyPost(exportXml);
} catch (e) {
  const after = {
    tally_exe: tallyProcessRunning(),
    port_9000: portListening(),
  };
  console.log("=== AFTER (request error) ===");
  console.log(JSON.stringify(after));
  console.log(
    JSON.stringify({
      final: "SAFE READBACK BLOCKED",
      reason: e.message,
      before,
      after,
      method,
    }),
  );
  process.exit(1);
}

const after = {
  tally_exe: tallyProcessRunning(),
  port_9000: portListening(),
};
console.log("=== AFTER ===");
console.log(JSON.stringify(after));
console.log("=== RESPONSE META ===");
console.log(JSON.stringify({ http_status: resp.status, elapsed_ms: resp.elapsedMs, body_len: resp.text.length }));
console.log("=== RESPONSE BODY (complete) ===");
console.log(resp.text);

if (!after.tally_exe || !after.port_9000) {
  console.log(
    JSON.stringify({
      final: "SAFE READBACK BLOCKED",
      reason: "tally_or_port_down_after_request",
      before,
      after,
      method,
    }),
  );
  process.exit(1);
}

if (resp.elapsedMs >= timeoutMs || resp.text.length === 0) {
  console.log(
    JSON.stringify({
      final: "SAFE READBACK BLOCKED",
      reason: "empty_or_timeout_response",
      before,
      after,
      method,
    }),
  );
  process.exit(1);
}

if (resp.text.includes("TallyPrime Server is Running") && resp.text.length < 120) {
  console.log(
    JSON.stringify({
      final: "SAFE READBACK BLOCKED",
      reason: "company_not_loaded_on_integration_server",
      before,
      after,
      method,
    }),
  );
  process.exit(1);
}

const date = extractTag(resp.text, ["DATE", "Date"]);
const vchType = extractTag(resp.text, ["VOUCHERTYPENAME", "VoucherTypeName"]);
const vchNo = extractTag(resp.text, ["VOUCHERNUMBER", "VoucherNumber"]);
const narration = extractTag(resp.text, ["NARRATION", "Narration"]);

const identityOk =
  (date === "20260406" || date === "6-Apr-2026" || date?.includes("20260406")) &&
  String(vchNo) === "3" &&
  narration === expectedNarration;

console.log("=== VOUCHER IDENTITY ===");
console.log(
  JSON.stringify({
    date,
    voucherTypeName: vchType,
    voucherNumber: vchNo,
    narration,
    identity_ok: identityOk,
    narration_contains_token: resp.text.includes(token),
  }),
);

if (!identityOk && !resp.text.includes(token)) {
  console.log(
    JSON.stringify({
      final: "SAFE READBACK BLOCKED",
      reason: "response_not_target_voucher",
      before,
      after,
      method,
    }),
  );
  process.exit(1);
}

const udfRaw = extractUdf(resp.text);
if (!udfRaw) {
  console.log(
    JSON.stringify({
      final: "UDF READBACK MISSING",
      identity_ok: identityOk,
      before,
      after,
      method,
      response_excerpt: resp.text.slice(0, 800),
    }),
  );
  process.exit(2);
}

let readObj;
try {
  readObj = JSON.parse(udfRaw);
} catch (e) {
  console.log(
    JSON.stringify({
      final: "UDF READBACK MISSING",
      reason: "udf_not_valid_json",
      parse_error: e.message,
      udf_excerpt: udfRaw.slice(0, 200),
      before,
      after,
      method,
    }),
  );
  process.exit(2);
}

const equal = JSON.stringify(readObj) === JSON.stringify(expectedPayload);
console.log(
  JSON.stringify({
    final: equal ? "METADATA ROUND-TRIP PASS" : "UDF READBACK MISSING",
    json_logical_equality: equal,
    read_obj: readObj,
    expected_token: token,
    before,
    after,
    method,
    elapsed_ms: resp.elapsedMs,
  }),
);
process.exit(equal ? 0 : 2);
