import type { TallySyncReportType } from "../tallyReportTypes.ts";
import { hoApprovalLabel, managerApprovalLabel } from "./classify.ts";

function formatTrackDateForTally(iso: unknown): string {
  const raw = String(iso ?? "").trim();
  const d = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return raw;
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y}`;
}

export function pipeSafe(v: unknown): string {
  return String(v ?? "")
    .replace(/\|/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function moneyPlain(v: unknown): string {
  const n = num(v);
  return n === 0 ? "" : n.toFixed(2);
}

export function buildClaimReportFlatRow(
  row: Record<string, unknown>,
  reportType: Extract<TallySyncReportType, "claim_verification" | "claim_approval">,
): string {
  const status = String(row.status ?? "");
  return [
    pipeSafe(row.user_name),
    pipeSafe(row.employee_id),
    pipeSafe(row.user_email),
    pipeSafe(row.transaction_number),
    pipeSafe(row.title),
    pipeSafe(row.purpose),
    pipeSafe(row.destination),
    pipeSafe(row.batch_ref),
    pipeSafe(row.category ?? "-"),
    formatTrackDateForTally(row.trip_start),
    formatTrackDateForTally(row.trip_end),
    moneyPlain(row.total_amount),
    pipeSafe(status),
    pipeSafe(managerApprovalLabel(reportType, status)),
    pipeSafe(hoApprovalLabel(reportType)),
    formatTrackDateForTally(row.created_at),
    moneyPlain(row.opening_balance),
    moneyPlain(row.closing_balance),
  ].join("|");
}

export function buildDetailedReportFlatRow(row: Record<string, unknown>): string {
  const credit = num(row.credit);
  const debit = num(row.debit);
  return [
    pipeSafe(row.employee_name),
    pipeSafe(row.employee_code),
    formatTrackDateForTally(row.effective_date ?? row.trip_start),
    pipeSafe(row.transaction_number),
    pipeSafe(row.title),
    pipeSafe(row.event_label ?? row.event_type),
    pipeSafe(row.category),
    pipeSafe(row.purpose),
    pipeSafe(row.destination),
    pipeSafe(row.batch_ref),
    credit > 0 ? credit.toFixed(2) : "",
    debit > 0 ? debit.toFixed(2) : "",
    pipeSafe(row.note),
    moneyPlain(row.opening_balance),
    moneyPlain(row.closing_balance),
  ].join("|");
}
