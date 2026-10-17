/**
 * Pure job planner: report-row snapshot + registry state -> delivery batches.
 * Runs identically in the edge worker and in tests (no I/O).
 */
import { employeeLedgerName, planPosting, planView } from "./aggregate.ts";
import { dailyToTxns, normalizeRow } from "./canonical.ts";
import {
  mastersEnvelope, reportGroupMasterXml, reportLedgerName, reportPrefix, reportRowMasterXml, viewFlat, viewRowKey,
  type ReportRowRecord,
} from "./reportRows.ts";
import type { CanonicalTxn, PlannedVoucher, PosterState, PwtAccountingConfig, PwtIssue, PwtReportType } from "./types.ts";
import { sha256Hex, stableStringify, xmlEscape } from "./util.ts";
import { vouchersImportXml } from "./xml.ts";

export const MASTERS_PER_BATCH = 200;
export const VOUCHERS_PER_BATCH = 40;

export interface PlanInput {
  organizationId: string;
  jobId: string;
  report: PwtReportType;
  company: string;
  rows: Record<string, unknown>[];
  cfg: PwtAccountingConfig;
  state: PosterState;
  /** Monotonic revision for report rows (epoch seconds of job creation). */
  revision: number;
}

export interface PlannedBatch {
  seq: number;
  kind: "masters" | "vouchers" | "report_rows";
  xml: string;
  item_count: number;
  voucher_numbers: string[];
  expected: Record<string, unknown>;
}

export interface JobPlan {
  batches: PlannedBatch[];
  reservations: { source_id: string; amount: number; voucher_number: string; voucher_date: string; content_hash: string }[];
  /** batch seq (string) -> voucher registry rows for pwt_vouchers */
  vouchers: Record<string, { date: string; number: string; serial: number; total: number }[]>;
  summary: {
    row_count: number;
    posted_count: number;
    voucher_count: number;
    issue_count: number;
    blocking_count: number;
    issues: PwtIssue[];
  };
  /** Source ids that must be re-planned if a registry conflict occurs. */
  rowRecords: ReportRowRecord[];
}

export async function rowContentHash(row: Record<string, unknown>): Promise<string> {
  return sha256Hex(stableStringify(row));
}

function chunk<T>(a: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

export async function buildJobPlan(inp: PlanInput): Promise<JobPlan> {
  const { organizationId: org, report, cfg } = inp;

  const txns: CanonicalTxn[] = []; // posting candidates (Detailed Expense / Claim Approval) and Claim Verification view rows
  const viewTxns: CanonicalTxn[] = []; // what this report DISPLAYS, aggregated
  const issues: PwtIssue[] = [];
  const unmappedDaily = new Map<string, number>();
  for (const row of inp.rows) {
    if (report === "daily_project") {
      const d = await dailyToTxns(org, row, cfg.dailyCostCategories ?? {});
      viewTxns.push(...d.txns);
      for (const u of d.unmapped) unmappedDaily.set(u.column, (unmappedDaily.get(u.column) ?? 0) + u.amount);
      continue;
    }
    const n = await normalizeRow(org, report, row);
    if (n.txn) {
      txns.push(n.txn);
      viewTxns.push(n.txn);
    } else if (n.error) {
      issues.push({ code: "BAD_ROW", sourceId: String(row.id ?? row.event_id ?? ""), detail: n.error, blocking: true });
    }
  }
  for (const [col, amt] of unmappedDaily) {
    issues.push({
      code: "UNMAPPED_EXPENSE_TYPE", sourceId: `daily:${col}`, blocking: false,
      detail: `Daily Project cost column "${col}" (${amt.toFixed(2)}) has no expense-type mapping and is not in the five-column view`,
    });
  }

  // 1) the five-column aggregated VIEW for this report (display only; never posts)
  const view = planView(cfg, viewTxns);
  for (const i of view.issues) if (i.code !== "NOT_APPROVED") issues.push({ ...i, blocking: i.blocking });
  const rowRecords: ReportRowRecord[] = [];
  for (const r of view.rows) {
    const key = viewRowKey(org, report, r);
    const flat = viewFlat(r);
    rowRecords.push({
      report, key, revision: inp.revision, jobId: inp.jobId, flat,
      name: await reportLedgerName(report, key, await sha256Hex(flat)),
    });
  }

  // 2) accounting (Detailed Expense + Claim Approval only; registry-gated)
  const plan = planPosting(cfg, txns, inp.state);
  for (const i of plan.issues) {
    // a blocking problem was already reported by the view for the same row; keep non-duplicates only
    if (!issues.some((x) => x.code === i.code && x.sourceId === i.sourceId)) issues.push(i);
  }

  const batches: PlannedBatch[] = [];
  const vouchersByBatch: JobPlan["vouchers"] = {};
  let seq = 0;
  const add = (b: Omit<PlannedBatch, "seq">) => {
    seq += 1;
    batches.push({ ...b, seq });
    return seq;
  };

  // 3a) masters: employee + expense ledgers (the connector prunes ones that already exist)
  if (plan.vouchers.length) {
    const ledgerMsgs = [
      ...plan.expenseLedgers.map((n) => ledgerMessage(n, cfg.expenseLedgerParent)),
      ...plan.employeeLedgers.map((n) => ledgerMessage(n, cfg.employeeLedgerParent)),
    ];
    for (const part of chunk(ledgerMsgs, MASTERS_PER_BATCH)) {
      add({
        kind: "masters", xml: mastersEnvelope(inp.company, part.map((m) => m.xml).join("")),
        item_count: part.length, voucher_numbers: [], expected: { ledgers: part.map((m) => m.name) },
      });
    }
  }

  // 3b) the report's five-column rows for the TDL (separate from vouchers). The LAST batch also prunes rows of
  // this report that are not in this snapshot, so a re-sync with different filters replaces the view exactly.
  const groupMsg = reportGroupMasterXml();
  const parts = rowRecords.length ? chunk(rowRecords, MASTERS_PER_BATCH) : [[]];
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    add({
      kind: "report_rows",
      xml: mastersEnvelope(inp.company, (i === 0 ? groupMsg : "") + part.map(reportRowMasterXml).join("")),
      item_count: part.length, voucher_numbers: [],
      expected: {
        ledgers: part.map((r) => r.name),
        group: i === 0 ? "PesoWise Report Data" : undefined,
        prune: last ? { prefix: reportPrefix(report), keep: rowRecords.map((r) => r.name) } : undefined,
      },
    });
  });

  // 3c) vouchers
  for (const part of chunk(plan.vouchers, VOUCHERS_PER_BATCH)) {
    const s = add({
      kind: "vouchers", xml: vouchersImportXml(inp.company, part), item_count: part.length,
      voucher_numbers: part.map((v) => v.voucherNumber),
      expected: { vouchers: part.map(expectedVoucher), tag: cfg.narrationTag },
    });
    vouchersByBatch[String(s)] = part.map((v) => ({
      date: v.date, number: v.voucherNumber, serial: serialOf(cfg, v), total: v.total,
    }));
  }

  const blocking = issues.filter((i) => i.blocking).length;
  return {
    batches,
    reservations: plan.postings.map((p) => ({
      source_id: p.sourceId, amount: p.amount, voucher_number: p.voucherNumber,
      voucher_date: p.voucherDate, content_hash: p.contentHash,
    })),
    vouchers: vouchersByBatch,
    rowRecords,
    summary: {
      row_count: inp.rows.length, posted_count: plan.postings.length, voucher_count: plan.vouchers.length,
      issue_count: issues.length, blocking_count: blocking,
      // keep the stored issue list bounded; counts above stay exact
      issues: issues.filter((i) => i.blocking).slice(0, 200).concat(issues.filter((i) => !i.blocking).slice(0, 50)),
    },
  };
}

function ledgerMessage(name: string, parent: string): { name: string; xml: string } {
  return {
    name,
    xml: `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlEscape(name)}" ACTION="Create">` +
      `<NAME>${xmlEscape(name)}</NAME><PARENT>${xmlEscape(parent)}</PARENT><ISBILLWISEON>No</ISBILLWISEON>` +
      `<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${xmlEscape(name)}</NAME></NAME.LIST></LANGUAGENAME.LIST></LEDGER></TALLYMESSAGE>`,
  };
}

function expectedVoucher(v: PlannedVoucher) {
  return { number: v.voucherNumber, date: v.date, total: v.total, lines: v.lines.length };
}

function serialOf(cfg: PwtAccountingConfig, v: PlannedVoucher): number {
  return Number(v.key.split("|")[1]);
}

export { employeeLedgerName };
