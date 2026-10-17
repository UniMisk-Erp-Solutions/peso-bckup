import type { CanonicalTxn, PwtReportType } from "./types.ts";
import { parseAmount, pick, round2, sha256Hex, stableStringify, toIsoDate } from "./util.ts";

type Row = Record<string, unknown>;

export interface NormalizeResult {
  txn?: CanonicalTxn;
  /** Row is valid report data but carries no accounting (e.g. Daily Project, credits). */
  skipped?: string;
  error?: string;
}

const s = (v: unknown) => String(v ?? "").trim();

/**
 * Normalises one report row into the canonical registry shape.
 * Field aliases cover PesoWise RPC JSON (snake_case) and the CSV export headers.
 */
export async function normalizeRow(orgId: string, report: PwtReportType, row: Row): Promise<NormalizeResult> {
  if (report === "daily_project") return { skipped: "daily_project carries no accounting" };

  const isDetailed = report === "detailed_expense";
  const expenseId = s(pick(row, ["expense_id", "id", "Expense ID"]));
  const txnNo = s(pick(row, ["transaction_number", "Transaction #"]));
  const key = expenseId || (txnNo ? `txn-${txnNo}` : "");

  let amount: number;
  let isLedgerDebit = false;
  if (isDetailed) {
    const eventType = s(pick(row, ["event_type", "Type"])).toLowerCase();
    const debit = parseAmount(pick(row, ["debit", "Debit"]));
    const credit = parseAmount(pick(row, ["credit", "Credit"]));
    if (Number.isFinite(credit) && credit > 0 && !(debit > 0)) return { skipped: "credit event" };
    if (eventType && !eventType.includes("deduct") && !eventType.includes("expense")) {
      return { skipped: `non-expense event ${eventType}` };
    }
    amount = debit;
    isLedgerDebit = true;
  } else {
    amount = parseAmount(pick(row, ["total_amount", "bill_amount", "Bill Amount", "amount"]));
  }
  // Non-expense ledger events (opening balances, credits) were skipped above; only a real expense row needs an identity.
  if (!key) return { error: "row has neither expense id nor transaction number" };

  const status = s(pick(row, ["status", "Status"]));
  const hoRaw = s(pick(row, ["ho_approval", "HO Approval", "ho_status"]));
  const txn: CanonicalTxn = {
    sourceId: `${orgId}:expense:${key}`,
    contentHash: "",
    organizationId: orgId,
    transactionNumber: txnNo,
    employeeId: s(pick(row, ["employee_code", "employee_id", "Employee ID", "Employee Code"])),
    employeeName: s(pick(row, ["employee_name", "user_name", "Employee", "User"])),
    expenseType: s(pick(row, ["category", "expense_type", "Expense Type"])),
    amount: Number.isFinite(amount) ? round2(amount) : NaN,
    billDate: toIsoDate(pick(row, ["effective_date", "bill_date", "trip_start", "Bill Date (DD-MM-YYYY)", "Date", "expense_date"])),
    origin: report,
    status,
    hoApproved: report === "claim_approval"
      ? (hoRaw ? hoRaw.toLowerCase() === "approved" : status.toLowerCase() === "approved")
      : false,
    isLedgerDebit,
  };
  txn.contentHash = await sha256Hex(stableStringify({
    s: txn.sourceId, e: txn.employeeId, t: txn.expenseType, a: txn.amount, d: txn.billDate,
  }));
  return { txn };
}

/**
 * Daily Project rows carry per-day cost columns instead of an expense type. Each mapped cost column becomes one
 * display transaction (never posted: daily_project is not a posting origin). Non-zero unmapped columns are reported.
 */
export async function dailyToTxns(
  orgId: string,
  row: Row,
  costMap: Record<string, string>,
): Promise<{ txns: CanonicalTxn[]; unmapped: { column: string; amount: number }[] }> {
  const costs = (row.costs && typeof row.costs === "object" ? row.costs : {}) as Row;
  const date = toIsoDate(row.track_date);
  const key = `${s(row.track_date)}|${s(row.user_id)}|${s(row.project_id)}|${s(row.voucher_no)}`;
  const txns: CanonicalTxn[] = [];
  const unmapped: { column: string; amount: number }[] = [];
  for (const [col, raw] of Object.entries(costs)) {
    const amount = parseAmount(raw);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const type = costMap[col];
    if (!type) {
      unmapped.push({ column: col, amount });
      continue;
    }
    const t: CanonicalTxn = {
      sourceId: `${orgId}:daily:${key}:${col}`, contentHash: "", organizationId: orgId, transactionNumber: s(row.voucher_no),
      employeeId: s(pick(row, ["employee_code", "employee_id"])), employeeName: s(pick(row, ["employee_name", "user_name"])),
      expenseType: type, amount: round2(amount), billDate: date, origin: "daily_project", status: "", hoApproved: false, isLedgerDebit: false,
    };
    t.contentHash = await sha256Hex(stableStringify({ s: t.sourceId, a: t.amount }));
    txns.push(t);
  }
  return { txns, unmapped };
}
