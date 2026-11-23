#!/usr/bin/env node
/**
 * Phase 5.1 — ONE inline-TDL filtered collection export to discover voucher IDs only.
 * Not built-in Collection ID=VOUCHER. No import. No retry.
 */
import http from "http";
import { execSync } from "child_process";

const host = "127.0.0.1";
const port = 9000;
const timeoutMs = 15_000;
const company = "PesoWise Integration Test";
const collName = "PWPhase51OneVchLookupColl";
const filterName = "PWPhase51OneVchFilter";
const expected = {
  date: "20260406",
  voucherType: "Payment",
  voucherNumber: "3",
  narration: "Phase51 balanced meta PW-META-BAL-mwbu7q3",
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
    const out = execSync(
      `powershell -NoProfile -Command "(Test-NetConnection -ComputerName ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded"`,
      { encoding: "utf8", timeout: 12_000 },
    ).trim();
    return out === "True";
  } catch {
    return false;
  }
}

function buildInlineCollectionXml() {
  const c = escapeXmlText(company);
  const narr = escapeXmlText(expected.narration);
  // Tally Case Study 1: custom Collection in TDLMESSAGE; FILTER via SYSTEM Formulae; minimal FETCH.
  // Not ID=VOUCHER (built-in). Filter targets one logical voucher before export shape.
  const filterFormula = `$Date = $$Date:20260406 AND $VoucherTypeName = &quot;Payment&quot; AND $VoucherNumber = &quot;3&quot; AND $Narration = &quot;${narr}&quot;`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>${collName}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVCURRENTCOMPANY>${c}</SVCURRENTCOMPANY>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No" NAME="${collName}">
            <TYPE>Voucher</TYPE>
            <FILTER>${filterName}</FILTER>
            <FETCH>Date, VoucherTypeName, VoucherNumber, Narration, MasterID, AlterID, GUID</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="${filterName}">${filterFormula}</SYSTEM>
        </TDLMESSAGE>
      </TDL>
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
    req.on("timeout", () => req.destroy(new Error("timeout_15s")));
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function extractTag(xml, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "gi");
    const matches = [...xml.matchAll(re)];
    if (matches.length) return matches.map((m) => decodeXmlText(m[1].trim()));
  }
  return [];
}

const method =
  "TYPE=Collection with inline TDL COLLECTION (NAME=PWPhase51OneVchLookupColl, TYPE=Voucher, FILTER formula on Date+Type+Number+Narration, FETCH identity fields only); NOT built-in ID=VOUCHER";

console.log("=== STATIC METHOD ===");
console.log(method);

const before = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
console.log("=== BEFORE ===");
console.log(JSON.stringify(before));

if (!before.port_9000) {
  console.log(JSON.stringify({ final: "TARGETED LOOKUP RUNTIME BLOCKED", reason: "port_9000_not_listening", before }));
  process.exit(1);
}

const xml = buildInlineCollectionXml();
console.log("=== REQUEST (filter redacted token visible — test voucher only) ===");
console.log(xml);

let resp;
try {
  resp = await tallyPost(xml);
} catch (e) {
  const after = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
  console.log("=== AFTER (error) ===");
  console.log(JSON.stringify(after));
  console.log(JSON.stringify({ final: "TARGETED LOOKUP RUNTIME BLOCKED", reason: e.message, before, after, method }));
  process.exit(1);
}

const after = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
console.log("=== AFTER ===");
console.log(JSON.stringify(after));
console.log("=== RESPONSE META ===");
console.log(JSON.stringify({ http_status: resp.status, elapsed_ms: resp.elapsedMs, body_len: resp.text.length }));
console.log("=== RESPONSE BODY (complete) ===");
console.log(resp.text);

if (!after.tally_exe || !after.port_9000) {
  console.log(JSON.stringify({ final: "TARGETED LOOKUP RUNTIME BLOCKED", reason: "tally_or_port_down_after", before, after, method }));
  process.exit(1);
}

const voucherBlocks = (resp.text.match(/<VOUCHER[\s>]/gi) ?? []).length;
const tallymessageVouchers = (resp.text.match(/<TALLYMESSAGE[\s\S]*?<VOUCHER/gi) ?? []).length;
const voucherCount = Math.max(voucherBlocks, tallymessageVouchers > 0 ? tallymessageVouchers : voucherBlocks);

if (resp.elapsedMs >= timeoutMs || resp.text.length === 0) {
  console.log(JSON.stringify({ final: "TARGETED LOOKUP RUNTIME BLOCKED", reason: "empty_or_timeout", before, after, method }));
  process.exit(1);
}

if (voucherCount > 1) {
  console.log(JSON.stringify({ final: "TARGETED LOOKUP RUNTIME BLOCKED", reason: "multiple_vouchers", voucherCount, before, after, method }));
  process.exit(1);
}

const dates = extractTag(resp.text, ["DATE", "Date"]);
const types = extractTag(resp.text, ["VOUCHERTYPENAME", "VoucherTypeName"]);
const numbers = extractTag(resp.text, ["VOUCHERNUMBER", "VoucherNumber"]);
const narrations = extractTag(resp.text, ["NARRATION", "Narration"]);
const masterIds = extractTag(resp.text, ["MASTERID", "MasterID"]);
const alterIds = extractTag(resp.text, ["ALTERID", "AlterID"]);
const guids = extractTag(resp.text, ["GUID", "Guid"]);

const identityOk =
  narrations.some((n) => n === expected.narration) &&
  numbers.some((n) => String(n) === expected.voucherNumber) &&
  types.some((t) => t === expected.voucherType) &&
  dates.some((d) => d === expected.date || d.includes("20260406") || d.includes("6-Apr-2026"));

if (!identityOk || masterIds.length === 0) {
  console.log(
    JSON.stringify({
      final: "TARGETED LOOKUP RUNTIME BLOCKED",
      reason: "zero_or_unverified_voucher",
      voucherCount,
      dates,
      types,
      numbers,
      narrations,
      masterIds,
      alterIds,
      guids,
      before,
      after,
      method,
    }),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    final: "TARGET VOUCHER ID FOUND",
    MasterID: masterIds[0],
    AlterID: alterIds[0] ?? null,
    GUID: guids[0] ?? null,
    date: dates[0],
    voucherTypeName: types[0],
    voucherNumber: numbers[0],
    narration: narrations[0],
    before,
    after,
    elapsed_ms: resp.elapsedMs,
    body_len: resp.text.length,
    method,
  }),
);
