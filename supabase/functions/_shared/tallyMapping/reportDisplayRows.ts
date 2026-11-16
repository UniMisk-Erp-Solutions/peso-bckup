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
  const value = String(v ?? "")
    .replace(/\|/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
  if (!value) return "__PW_EMPTY__";
  return value === "__PW_EMPTY__" ? "__PW_EMPTY____PW_EMPTY__" : value;
}

function moneyPlain(v: unknown): string {
  // Match the browser mapper: preserve explicit ₹0.00 values while keeping
  // genuinely empty CSV/report cells blank.
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return "__PW_EMPTY__";
  const normalized = typeof v === "string" ? v.replace(/[₹,\s]/g, "") : v;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
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
    pipeSafe(formatTrackDateForTally(row.trip_start)),
    pipeSafe(formatTrackDateForTally(row.trip_end)),
    moneyPlain(row.total_amount),
    pipeSafe(status),
    pipeSafe(managerApprovalLabel(reportType, status)),
    pipeSafe(hoApprovalLabel(reportType)),
    pipeSafe(formatTrackDateForTally(row.created_at)),
    moneyPlain(row.opening_balance),
    moneyPlain(row.closing_balance),
    pipeSafe(row.lpo_number),
  ].join("|");
}

export function buildDetailedReportFlatRow(row: Record<string, unknown>): string {
  const custom = row.custom_fields && typeof row.custom_fields === "object"
    ? row.custom_fields as Record<string, unknown>
    : {};
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
    pipeSafe(custom["From location"]),
    pipeSafe(custom["Project ID"]),
    pipeSafe(custom["Project Name"]),
    pipeSafe(custom["Project Unique ID"]),
    pipeSafe(custom["To location"]),
    moneyPlain(row.credit),
    moneyPlain(row.debit),
    pipeSafe(row.note),
    moneyPlain(row.opening_balance),
    moneyPlain(row.closing_balance),
  ].join("|");
}
