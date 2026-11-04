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
  reservations: {
    source_id: string; amount: number; voucher_number: string; voucher_date: string; content_hash: string;
    /** Recorded so a later deletion of the expense can be corrected in Tally exactly. */
    employee_ledger: string; expense_ledger: string; serial: number;
    /** Recorded so a later edit of the expense can be detected. */
    expense_type: string;
  }[];
  /** Already-posted expenses edited since they were posted (queued for correction in Tally, then re-posted). */
  edits: { source_id: string; changed: string[]; was: Record<string, unknown>; now: Record<string, unknown> }[];
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

/** Report rows turned into canonical transactions (the CPU-heavy hashing step), ready to be planned. Chunks of it can be merged. */
export interface NormalizedRows {
  /** posting candidates (Detailed Expense / Claim Approval) and Claim Verification view rows */
  post: CanonicalTxn[];
  /** what this report DISPLAYS, aggregated */
  view: CanonicalTxn[];
  issues: PwtIssue[];
  /** Daily Project cost columns with no expense-type mapping: column -> total amount */
  unmappedDaily: [string, number][];
  rowCount: number;
}

export function mergeNormalized(parts: readonly NormalizedRows[]): NormalizedRows {
  const unmapped = new Map<string, number>();
  const out: NormalizedRows = { post: [], view: [], issues: [], unmappedDaily: [], rowCount: 0 };
  for (const p of parts) {
    for (const t of p.post) out.post.push(t);
    for (const t of p.view) out.view.push(t);
    for (const i of p.issues) out.issues.push(i);
    for (const [c, a] of p.unmappedDaily) unmapped.set(c, (unmapped.get(c) ?? 0) + a);
    out.rowCount += p.rowCount;
  }
  out.unmappedDaily = [...unmapped];
  return out;
}

export async function normalizeRows(org: string, report: PwtReportType, rows: readonly Record<string, unknown>[], cfg: PwtAccountingConfig): Promise<NormalizedRows> {
  const txns: CanonicalTxn[] = [];
  const viewTxns: CanonicalTxn[] = [];
  const issues: PwtIssue[] = [];
  const unmappedDaily = new Map<string, number>();
  for (const row of rows) {
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
  return { post: txns, view: viewTxns, issues, unmappedDaily: [...unmappedDaily], rowCount: rows.length };
}

export async function buildJobPlan(inp: PlanInput): Promise<JobPlan> {
  return buildJobPlanFromNormalized(inp, await normalizeRows(inp.organizationId, inp.report, inp.rows, inp.cfg));
}

/** Plans the vouchers from already-normalised rows. Everything CPU-heavy per row has been done; this only groups and builds XML. */
export async function buildJobPlanFromNormalized(inp: Omit<PlanInput, "rows">, n: NormalizedRows): Promise<JobPlan> {
  const { organizationId: org, report, cfg } = inp;
  const txns = n.post;
  const viewTxns = n.view;
  const issues: PwtIssue[] = [...n.issues];
  for (const [col, amt] of n.unmappedDaily) {
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
  // a blocking problem was already reported by the view for the same row; keep non-duplicates only (a Set: a re-sync can have 10,000+ notices)
  const seen = new Set(issues.map((x) => `${x.code}|${x.sourceId}`));
  for (const i of plan.issues) {
    const k = `${i.code}|${i.sourceId}`;
    if (!seen.has(k)) {
      issues.push(i);
      seen.add(k);
    }
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

  // 3b) the report's five-column rows for the TDL (separate from vouchers). OFF by default: nothing is stored in Tally, and one prune-only
  // batch removes any report rows this report left behind in earlier syncs. The LAST batch also prunes rows of this report that are not in
  // this snapshot, so a re-sync with different filters replaces the view exactly.
  // Detailed Expense and Claim Approval screens read the real vouchers, so only the two display-only reports ever store report rows.
  if (cfg.reportRowsInTally && (report === "daily_project" || report === "claim_verification")) {
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
  } else {
    add({
      kind: "report_rows", xml: mastersEnvelope(inp.company, ""), item_count: 0, voucher_numbers: [],
      expected: { ledgers: [], prune: { prefix: reportPrefix(report), keep: [] } },
    });
  }

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
      employee_ledger: p.employeeLedger, expense_ledger: p.expenseLedger, serial: p.serial, expense_type: p.expenseType,
    })),
    edits: plan.edits.map((e) => ({ source_id: e.sourceId, changed: [...e.changed], was: { ...e.was }, now: { ...e.now } })),
    vouchers: vouchersByBatch,
    rowRecords,
    summary: {
      row_count: n.rowCount, posted_count: plan.postings.length, voucher_count: plan.vouchers.length,
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
