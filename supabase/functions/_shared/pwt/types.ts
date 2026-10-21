/**
 * PesoWise -> TallyPrime ("pwt") shared types.
 * Pure TypeScript: no Deno / Node / DOM APIs, so edge functions, the connector and vitest all import it.
 */

export type PwtReportType =
  | "daily_project"
  | "detailed_expense"
  | "claim_verification"
  | "claim_approval";

export const PWT_REPORT_TYPES: readonly PwtReportType[] = [
  "daily_project",
  "detailed_expense",
  "claim_verification",
  "claim_approval",
];

/** One PesoWise expense transaction, normalised from any of the report row shapes. */
export interface CanonicalTxn {
  /** Stable registry key, identical across reports: `${orgId}:expense:${expenseId}`. */
  sourceId: string;
  /** sha-256 hex (or injected hash) over the accounting-relevant fields. */
  contentHash: string;
  organizationId: string;
  transactionNumber: string;
  employeeId: string; // employee code as shown in reports (Sumit "Employee ID")
  employeeName: string;
  expenseType: string; // PesoWise category label
  /** Positive amount to debit the expense ledger. */
  amount: number;
  /** ISO yyyy-mm-dd of the bill / ledger effective date. */
  billDate: string;
  /** Which report this row arrived through. */
  origin: PwtReportType;
  /** Raw PesoWise status text if the report carries one. */
  status: string;
  hoApproved: boolean;
  /** True when this row represents a posted deduction (Detailed Expense debit). */
  isLedgerDebit: boolean;
}

/** Five-column intermediate format (Sumit "Import Sheet"). */
export interface ImportRow {
  voucherDate: string; // ISO yyyy-mm-dd ("Voucher Date (Tally)")
  expenseLedger: string; // "Expense Ledger"
  employeeLedger: string; // "Employe Ledger" (sic)
  voucherId: string; // "Voucher ID"
  total: number; // "Total"
  /** Not part of the five columns: registry keys that rolled into this row. */
  sourceIds: string[];
}

export interface ExpenseCategoryRule {
  /** PesoWise expense type (exact, case/space-insensitive match). */
  expenseType: string;
  /** Aliases that resolve to the same rule (renamed categories). */
  aliases?: string[];
  /** 1-based voucher serial, as in the workbook "Voucher Serial". */
  serial: number;
  /** Tally expense ledger name. */
  expenseLedger: string;
}

export interface PwtAccountingConfig {
  voucherType: string; // default "Journal"
  /** Voucher number prefix, default "PESO". Number = `${prefix}/${MM}/${NN}`. */
  voucherPrefix: string;
  /**
   * Which side the expense ledger sits on. Sumit's workbook sums "Debit" and the
   * employee balance is an advance that gets reduced, so expense=Dr / employee=Cr.
   * This MUST be confirmed by the accountant before any real-company import.
   */
  expenseSide: "debit" | "credit";
  /** "month_end" = last day of the bill month; "fixed" uses fixedPostingDate. */
  postingDatePolicy: "month_end" | "fixed";
  fixedPostingDate?: string;
  /** Parent group for auto-created employee ledgers. */
  employeeLedgerParent: string;
  /** Parent group for expense ledgers if they must be created. */
  expenseLedgerParent: string;
  categories: ExpenseCategoryRule[];
  /** Optional explicit employee-id -> ledger name overrides. */
  employeeLedgerOverrides?: Record<string, string>;
  /** Marker written into narration so readback can find our vouchers. */
  narrationTag: string;
  /**
   * Also store each report row in TallyPrime (as hidden ledgers) so the "PesoWise Reports" screens can show it. OFF by default: those
   * ledgers appear in every ledger picker. When off, a sync writes only real accounting (vouchers) and removes any report rows left by
   * earlier syncs of that report.
   */
  reportRowsInTally?: boolean;
  /**
   * Daily Project cost column key -> PesoWise expense type, so its cost columns aggregate through the same
   * category rules. Only unambiguous pairs are defaulted; any other non-zero cost column is reported, never guessed.
   */
  dailyCostCategories?: Record<string, string>;
}

export type PwtIssueCode =
  | "UNMAPPED_EXPENSE_TYPE"
  | "MISSING_EMPLOYEE_ID"
  | "NON_POSITIVE_AMOUNT"
  | "BAD_DATE"
  | "BAD_ROW"
  | "NOT_APPROVED"
  | "ALREADY_POSTED"
  | "AMOUNT_MISMATCH";

export interface PwtIssue {
  code: PwtIssueCode;
  sourceId: string;
  detail: string;
  /** Blocking issues keep the row out of the vouchers and fail the job into "needs attention". */
  blocking: boolean;
}

export interface VoucherLine {
  ledger: string;
  /** "debit" lines have negative Tally AMOUNT + ISDEEMEDPOSITIVE=Yes. */
  side: "debit" | "credit";
  amount: number;
}

export interface PlannedVoucher {
  /** Deterministic key: `${orgId}|${date}|${serial}|${seq}` */
  key: string;
  date: string; // ISO
  voucherType: string;
  voucherNumber: string;
  narration: string;
  lines: VoucherLine[];
  total: number;
  sourceIds: string[];
}

export interface AggregationResult {
  rows: ImportRow[];
  vouchers: PlannedVoucher[];
  issues: PwtIssue[];
  /** Employee ledgers that must exist in Tally before vouchers import. */
  employeeLedgers: string[];
  expenseLedgers: string[];
  postedSourceIds: string[];
  /** Per-expense posting facts for the registry reservation. */
  postings: { sourceId: string; amount: number; contentHash: string; voucherNumber: string; voucherDate: string; serial: number; employeeLedger: string; expenseLedger: string }[];
}

export interface PosterState {
  /** Source ids already posted (registry). */
  postedSourceIds: ReadonlySet<string>;
  /** Number of vouchers already posted per `${date}|${serial}` (for supplementary numbering). */
  voucherCounts: Readonly<Record<string, number>>;
  /** Amounts previously posted by sourceId, for mismatch detection. */
  postedAmounts?: Readonly<Record<string, number>>;
}
