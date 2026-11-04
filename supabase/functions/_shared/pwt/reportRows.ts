/**
 * Tally-side storage for the four reports.
 *
 * Every report shows the SAME five columns as the accountant's workbook "Import Sheet", aggregated by the shared
 * engine (employee ledger x expense ledger x voucher date), never the original 20/23/24 PesoWise columns:
 *   Voucher Date (Tally) | Expense Ledger | Employe Ledger | Voucher ID | Total
 *
 * Each aggregated row is stored as one metadata ledger in group "PesoWise Report Data" (separate from vouchers) holding a flat
 * pipe-delimited string in UDF PWTCELLS. TDL reads tokens from that string (no JSON at report time).
 *   token: 1 ISO date (sort) | 2 display date | 3 expense ledger | 4 employee ledger | 5 voucher id | 6 total (Indian format) | 7 total (raw)
 */
import type { ImportRow, PwtReportType } from "./types.ts";
import { sha256Hex, xmlEscape } from "./util.ts";

export const REPORT_GROUP = "PesoWise Report Data";
export const REPORT_GROUP_PARENT = "Suspense A/c";
export const PWT_UDF = { report: "PWTREPORT", key: "PWTKEY", rev: "PWTREV", job: "PWTJOB", cells: "PWTCELLS" } as const;

/** Exact headings and order (the workbook's spelling, including "Employe"). */
export const FIVE_COLUMNS = ["Voucher Date (Tally)", "Expense Ledger", "Employe Ledger", "Voucher ID", "Total"] as const;

export const REPORT_COLUMNS: Record<PwtReportType, readonly string[]> = {
  daily_project: FIVE_COLUMNS,
  detailed_expense: FIVE_COLUMNS,
  claim_verification: FIVE_COLUMNS,
  claim_approval: FIVE_COLUMNS,
};

/** 2207674.69 -> "22,07,674.69" (Indian grouping, 2 decimals). */
export function formatIndian(n: number): string {
  const neg = n < 0;
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  let head = int.slice(-3);
  let rest = int.slice(0, -3);
  while (rest.length > 2) {
    head = rest.slice(-2) + "," + head;
    rest = rest.slice(0, -2);
  }
  if (rest) head = rest + "," + head;
  return `${neg ? "-" : ""}${head}.${dec}`;
}

export function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

const EMPTY = "__PW_EMPTY__";
export function pipeSafe(v: string): string {
  const s = v.replace(/\|/g, " ").replace(/\r?\n/g, " ").trim();
  if (!s) return EMPTY;
  return s === EMPTY ? EMPTY + EMPTY : s;
}

/** One aggregated import row -> the flat string the TDL reads. */
export function viewFlat(r: Pick<ImportRow, "voucherDate" | "expenseLedger" | "employeeLedger" | "voucherId" | "total">): string {
  return [
    r.voucherDate, ddmmyyyy(r.voucherDate), r.expenseLedger, r.employeeLedger, r.voucherId, formatIndian(r.total), r.total.toFixed(2),
  ].map(pipeSafe).join("|");
}

/** Stable identity of one aggregated row (revision-independent): the pivot group. */
export function viewRowKey(orgId: string, report: PwtReportType, r: Pick<ImportRow, "voucherDate" | "expenseLedger" | "employeeLedger">): string {
  return `${orgId}:${report}:${r.voucherDate}|${r.expenseLedger}|${r.employeeLedger}`;
}

const SHORT: Record<PwtReportType, string> = { daily_project: "DP", detailed_expense: "DE", claim_verification: "CV", claim_approval: "CA" };
export const reportPrefix = (report: PwtReportType) => `PWT-${SHORT[report]}-`;

export async function reportLedgerName(report: PwtReportType, key: string, contentHash: string): Promise<string> {
  const k = (await sha256Hex(key)).slice(0, 16);
  return `${reportPrefix(report)}${k}-${contentHash.slice(0, 8)}`;
}

export function reportGroupMasterXml(): string {
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><GROUP NAME="${xmlEscape(REPORT_GROUP)}" ACTION="Create">` +
    `<NAME>${xmlEscape(REPORT_GROUP)}</NAME><PARENT>${xmlEscape(REPORT_GROUP_PARENT)}</PARENT>` +
    `<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${xmlEscape(REPORT_GROUP)}</NAME></NAME.LIST></LANGUAGENAME.LIST></GROUP></TALLYMESSAGE>`;
}

export interface ReportRowRecord {
  report: PwtReportType;
  key: string;
  revision: number;
  jobId: string;
  name: string;
  flat: string;
}

export function reportRowMasterXml(r: ReportRowRecord): string {
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xmlEscape(r.name)}" ACTION="Create">` +
    `<NAME>${xmlEscape(r.name)}</NAME><PARENT>${xmlEscape(REPORT_GROUP)}</PARENT><ISBILLWISEON>No</ISBILLWISEON>` +
    `<LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>${xmlEscape(r.name)}</NAME></NAME.LIST></LANGUAGENAME.LIST>` +
    `<UDF:${PWT_UDF.report} TYPE="String">${xmlEscape(r.report)}</UDF:${PWT_UDF.report}>` +
    `<UDF:${PWT_UDF.key} TYPE="String">${xmlEscape(r.key)}</UDF:${PWT_UDF.key}>` +
    `<UDF:${PWT_UDF.rev} TYPE="String">${String(r.revision).padStart(12, "0")}</UDF:${PWT_UDF.rev}>` +
    `<UDF:${PWT_UDF.job} TYPE="String">${xmlEscape(r.jobId)}</UDF:${PWT_UDF.job}>` +
    `<UDF:${PWT_UDF.cells} TYPE="String">${xmlEscape(r.flat)}</UDF:${PWT_UDF.cells}></LEDGER></TALLYMESSAGE>`;
}

/** Wrap prebuilt TALLYMESSAGE fragments in an "All Masters" import envelope for `company`. */
export function mastersEnvelope(company: string, messages: string): string {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>` +
    `<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>` +
    `</STATICVARIABLES></REQUESTDESC><REQUESTDATA>${messages}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
