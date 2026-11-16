/** Shared Phase 5.3 production mapping + local Tally HTTP helpers. */
import http from "node:http";
import { execSync } from "node:child_process";
import {
  metadataLedgerName,
  reportMetadataDeliveryKey,
} from "../../src/lib/tallyMapping/identities.ts";
import { contentHash } from "../../src/lib/tallySync/contentHash.ts";
import type { DeliveryStateRow, PreparedJobItem } from "../../src/lib/tallyMapping/types.ts";

export const host = "127.0.0.1";
export const port = 9000;
export const timeoutMs = 15_000;
export const company = "PesoWise Integration Test";

export const PHASE53_ORG = "33333333-3333-3333-3333-333333333333";
export const PHASE53_USER = "44444444-4444-4444-4444-444444444444";
export const PHASE53_PROJECT = "55555555-5555-5555-5555-555555555555";
export const PHASE53_TRACK = "2026-10-06";

/** Test A baseline (CREATE already passed in real Tally). */
export const PHASE53_TEST_A_TOKEN = "phase53-test-a-controlled-create";
export const PHASE53_TEST_A_HASH = "f6391e5c70a22d2f6d690f2f146ebcc547b7a4d638b3640217a861ba1f973d9c";

/** Post–manual-alter baseline on real ledger (export proof). */
export const PHASE53_MANUAL_ALTER_TOKEN = "phase53-manual-alter-proof";

export const PHASE53_TEST_C_TOKEN = "phase53-test-c-production-alter-pass";

/** Real-Tally validation only — set via PHASE53_TALLY_LEDGER_GUID (not hard-coded in mapper). */
export function phase53TallyLedgerGuidForValidation(): string | null {
  const g = process.env.PHASE53_TALLY_LEDGER_GUID?.trim();
  return g || null;
}

export function phase53SourceKey(): string {
  return `${PHASE53_ORG}:daily_row:${PHASE53_TRACK}|${PHASE53_USER}|${PHASE53_PROJECT}`;
}

export function phase53MetaKey(): string {
  return reportMetadataDeliveryKey(PHASE53_ORG, "daily_project_report", phase53SourceKey());
}

export function phase53LedgerName(): string {
  return metadataLedgerName(phase53MetaKey());
}

export async function buildPhase53PreparedItem(remarksToken: string): Promise<PreparedJobItem> {
  const sourceKey = phase53SourceKey();
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
    remarks: remarksToken,
    phase53: {
      test:
        remarksToken === PHASE53_TEST_C_TOKEN
          ? "C"
          : remarksToken === PHASE53_MANUAL_ALTER_TOKEN
            ? "manual"
            : "A",
      token: remarksToken,
      source: "production_mapper_serializer",
    },
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

export function deliveredStateRow(metaKey: string, hash: string): DeliveryStateRow {
  const guid = phase53TallyLedgerGuidForValidation();
  return {
    organization_id: PHASE53_ORG,
    delivery_key: metaKey,
    delivery_kind: "report_metadata",
    last_content_hash: hash,
    tally_remote_id: guid ?? phase53LedgerName(),
    last_action: "create",
    last_job_id: "phase53-test-a",
    peso_deleted_at: null,
    cancel_strategy: null,
  };
}

export function tallyProcessRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq tally.exe" /FO CSV /NH', { encoding: "utf8" });
    return out.toLowerCase().includes("tally.exe");
  } catch {
    return false;
  }
}

export function portListening(): boolean {
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

export function tallyPost(xml: string): Promise<{ status: number; text: string; elapsedMs: number }> {
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

export function wrapEnvelopeForCompany(innerMessages: string): string {
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
