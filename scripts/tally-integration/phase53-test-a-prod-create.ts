/**
 * Phase 5.3 — Test A ONLY: one production metadata-ledger CREATE to local Tally.
 * Run: npx --yes tsx scripts/tally-integration/phase53-test-a-prod-create.ts
 */
import http from "node:http";
import { execSync } from "node:child_process";
import { parseTallyImportResponse } from "../../connector/tally/dist/responseParser.js";
import { mapPreparedJobItems } from "../../src/lib/tallyMapping/pipeline.ts";
import { serializeCommand } from "../../src/lib/tallyMapping/xml/serialize.ts";
import {
  metadataLedgerName,
  reportMetadataDeliveryKey,
} from "../../src/lib/tallyMapping/identities.ts";
import { contentHash } from "../../src/lib/tallySync/contentHash.ts";
import type { PreparedJobItem } from "../../src/lib/tallyMapping/types.ts";

const host = "127.0.0.1";
const port = 9000;
const timeoutMs = 15_000;
const company = "PesoWise Integration Test";

/** Synthetic org/row — not production data. */
const PHASE53_ORG = "33333333-3333-3333-3333-333333333333";
const PHASE53_USER = "44444444-4444-4444-4444-444444444444";
const PHASE53_PROJECT = "55555555-5555-5555-5555-555555555555";
const PHASE53_TRACK = "2026-10-06";
const PHASE53_TOKEN = "phase53-test-a-controlled-create";

function tallyProcessRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq tally.exe" /FO CSV /NH', { encoding: "utf8" });
    return out.toLowerCase().includes("tally.exe");
  } catch {
    return false;
  }
}

function portListening(): boolean {
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

function tallyPost(xml: string): Promise<{ status: number; text: string; elapsedMs: number }> {
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
        const chunks: Buffer[] = [];
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

function wrapEnvelopeForCompany(innerMessages: string): string {
  const c = company
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
${innerMessages}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

async function buildPhase53PreparedItem(): Promise<PreparedJobItem> {
  const sourceKey = `${PHASE53_ORG}:daily_row:${PHASE53_TRACK}|${PHASE53_USER}|${PHASE53_PROJECT}`;
  const row = {
    track_date: PHASE53_TRACK,
    user_id: PHASE53_USER,
    project_id: PHASE53_PROJECT,
    project_name: "Phase 5.3 Synthetic Project",
    location: "TEST-NO-ACCT",
    employee_name: "Phase53 Synthetic",
    costs: { synthetic: 0 },
    percent: { synthetic: 0 },
    source_expenses: [] as { id: string; amount: number }[],
    remarks: PHASE53_TOKEN,
    phase53: { test: "A", token: PHASE53_TOKEN, source: "production_mapper_serializer" },
  };
  const hash = await contentHash(row);
  return {
    seq: 1,
    source_type: "daily_report_row",
    source_key: sourceKey,
    content_hash: hash,
    payload: {
      organization_id: PHASE53_ORG,
      report_type: "daily_project_report",
      track_date: PHASE53_TRACK,
      user_id: PHASE53_USER,
      project_id: PHASE53_PROJECT,
      row,
    },
  };
}

async function main() {
  let httpRequestCount = 0;
  const before = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
  console.log("=== PHASE 5.3 TEST A — PRODUCTION CREATE ===");
  console.log(JSON.stringify({ step: "precheck_before", before }));

  if (!before.tally_exe || !before.port_9000) {
    console.log(
      JSON.stringify({
        final: "PHASE 5.3 TEST A FAILED — STOPPED SAFELY",
        reason: "tally_exe_or_port_not_ready",
        http_request_count: httpRequestCount,
      }),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      step: "group_precheck",
      note:
        "PesoWise Metadata group verified by Phase 5.1 (PW-META-MANUAL-001 / HTTP-001 parent). No GROUP HTTP in 5.3A.",
      modify_group: false,
    }),
  );

  const item = await buildPhase53PreparedItem();
  const metaKey = reportMetadataDeliveryKey(
    PHASE53_ORG,
    "daily_project_report",
    item.source_key,
  );
  const ledgerName = metadataLedgerName(metaKey);

  const mapped = mapPreparedJobItems([item], {
    organization_id: PHASE53_ORG,
    job_id: "phase53-test-a",
    delivery_state: [],
  });

  const metaCmd = mapped.commands.find((c) => c.kind === "report_metadata");
  if (!metaCmd || metaCmd.kind !== "report_metadata") {
    console.log(JSON.stringify({ final: "FAILED", reason: "no_report_metadata_command" }));
    process.exit(1);
  }

  const action = metaCmd.metadata.action;
  const xmlFragment = serializeCommand(metaCmd);
  const envelope = wrapEnvelopeForCompany(xmlFragment);

  const checks = {
    is_ledger: xmlFragment.includes("<LEDGER"),
    action_create: /LEDGER ACTION="Create"/.test(xmlFragment),
    parent: xmlFragment.includes("<PARENT>PesoWise Metadata</PARENT>"),
    udf_index_25001: xmlFragment.includes('INDEX="25001"'),
    udf_json: xmlFragment.includes("PESOWISE_METADATA_JSON"),
    no_voucher: !/<VOUCHER/i.test(xmlFragment),
    no_opening_balance: !/OPENINGBALANCE/i.test(xmlFragment),
    no_ledger_entries: !/ALLLEDGERENTRIES/i.test(xmlFragment),
    ledger_name_in_xml: xmlFragment.includes(ledgerName),
    stable_key_udf: xmlFragment.includes(metaKey),
  };

  console.log(
    JSON.stringify({
      step: "production_identity",
      code_path: "mapPreparedJobItems → serializeCommand (metadata ledger only; no GROUP in envelope)",
      report_type: "daily_project_report",
      source_key: item.source_key,
      reportMetadataDeliveryKey: metaKey,
      content_hash: item.content_hash,
      ledger_name: ledgerName,
      generated_action: action,
      xml_checks: checks,
      non_metadata_commands_excluded: mapped.commands
        .filter((c) => c.kind !== "report_metadata")
        .map((c) => c.kind),
    }),
  );

  if (!checks.action_create || !checks.is_ledger || !checks.parent) {
    console.log(JSON.stringify({ final: "FAILED", reason: "xml_precheck_failed", checks }));
    process.exit(1);
  }

  console.log("=== EXACT XML SENT (complete) ===");
  console.log(envelope);

  let resp;
  try {
    httpRequestCount += 1;
    resp = await tallyPost(envelope);
  } catch (e) {
    const after = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
    console.log(
      JSON.stringify({
        final: "PHASE 5.3 TEST A FAILED — STOPPED SAFELY",
        reason: e instanceof Error ? e.message : String(e),
        http_request_count: httpRequestCount,
        after,
      }),
    );
    process.exit(1);
  }

  const after = { tally_exe: tallyProcessRunning(), port_9000: portListening() };
  const parsed = parseTallyImportResponse(resp.text);
  const errorsTag = Number(/<ERRORS[^>]*>(\d+)/i.exec(resp.text)?.[1] ?? -1);
  const exceptionsTag = Number(/<EXCEPTIONS[^>]*>(\d+)/i.exec(resp.text)?.[1] ?? -1);
  const lineErrors = [...resp.text.matchAll(/<LINEERROR>([^<]*)<\/LINEERROR>/gi)].map((m) => m[1]);

  console.log(JSON.stringify({ step: "precheck_after", after }));
  console.log(
    JSON.stringify({
      step: "tally_response_counters",
      http_request_count: httpRequestCount,
      http_status: resp.status,
      elapsed_ms: resp.elapsedMs,
      CREATED: parsed.created,
      ALTERED: parsed.altered,
      ERRORS: errorsTag,
      EXCEPTIONS: exceptionsTag,
      LINEERROR: lineErrors,
    }),
  );
  console.log("=== EXACT TALLY RESPONSE (complete) ===");
  console.log(resp.text);

  if (!after.tally_exe || !after.port_9000) {
    console.log(JSON.stringify({ final: "PHASE 5.3 TEST A FAILED — STOPPED SAFELY", reason: "tally_down_after" }));
    process.exit(1);
  }

  const pass =
    parsed.created === 1 &&
    parsed.altered === 0 &&
    errorsTag === 0 &&
    exceptionsTag === 0 &&
    lineErrors.length === 0;

  if (!pass) {
    console.log(JSON.stringify({ final: "PHASE 5.3 TEST A FAILED — STOPPED SAFELY", do_not_run_skip_or_alter: true }));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      final: "PHASE 5.3 TEST A CREATE PASS — MANUAL CHECKPOINT REQUIRED",
      ledger_name: ledgerName,
      stable_key: metaKey,
      content_hash: item.content_hash,
      manual_step:
        "Open this Ledger in TallyPrime (PesoWise Integration Test) and confirm PESOWISE_METADATA_JSON shows phase53 token",
      stop: "Do NOT run SKIP or ALTER until manual confirm",
      pending_smoke_batches: "untouched",
      connector: "not started",
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
