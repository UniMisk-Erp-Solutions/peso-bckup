/**
 * Server-side builders for Claim Verification, Claim Approval and
 * Detailed Expense.
 *
 * These three used to page every row into the browser and build their files
 * there. The column sets, balance walks, custom-field ordering and INR/date
 * formatting below are direct ports of the client code they replace, so a
 * server-produced file matches what the tab produced. Where the client used a
 * translated header, the English string is used — an export is data, and a file
 * whose columns move with a UI language setting cannot be diffed or scripted.
 */

const PAGE_SIZE = 250;
/** report_detailed_expense_rows_v4 clamps p_page_size at 500. Every page recomputes the full ordered timeline, so half the pages is roughly half the wall-clock. */
const DETAILED_PAGE_SIZE = 500;

/**
 * Message for a report that cannot finish inside one worker invocation. The
 * Edge Function platform kills a request at 60 s (main/index.ts workerTimeoutMs),
 * silently, leaving the job `running` until stale recovery; failing cleanly
 * before that with a reason the user can act on is strictly better. A worker
 * that hits it is NOT retried -- the same input would hit it again.
 */
export const REPORT_TOO_LARGE_MESSAGE =
  "This report is too large to build in one pass. Narrow the date range or filters and try again.";

/** Matches src/lib/format.ts defaultInrFormatter exactly. */
const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

export function formatINR(n: number): string {
  return Number.isFinite(n) ? INR.format(n) : "₹0.00";
}

/** DD-MM-YYYY, matching formatDateDDMMYYYY. Accepts a date or a timestamp. */
export function formatDDMMYYYY(value: string | null): string {
  if (!value) return "";
  const d = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return "";
  const [y, m, day] = d.split("-");
  return `${day}-${m}-${y}`;
}

export interface ExpenseRow {
  id: string;
  user_id: string;
  title: string | null;
  total_amount: number | null;
  status: string | null;
  created_at: string;
  trip_start: string;
  trip_end: string;
  category: string | null;
  purpose: string | null;
  destination: string | null;
  transaction_number: string | null;
  user_name: string;
  user_email: string;
  employee_id: string;
  user_balance: number;
  batch_ref: string;
  custom_fields: Record<string, string>;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Union of custom-field labels, ordered like sortedCustomFieldKeys. */
export function customKeys(rows: ExpenseRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.custom_fields ?? {})) keys.add(k);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

type Balance = { opening: number; closing: number };

function groupByUser(rows: ExpenseRow[]): Map<string, ExpenseRow[]> {
  const m = new Map<string, ExpenseRow[]>();
  for (const r of rows) {
    if (!m.has(r.user_id)) m.set(r.user_id, []);
    m.get(r.user_id)!.push(r);
  }
  return m;
}

function chronological(list: ExpenseRow[]): ExpenseRow[] {
  return [...list].sort((a, b) => {
    const d = new Date(a.trip_start).getTime() - new Date(b.trip_start).getTime();
    if (d !== 0) return d;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

/**
 * Verification: these claims are NOT yet deducted from the wallet, so the walk
 * starts above the current balance and steps down. Port of
 * computeRowBalancesForVerification.
 */
export function balancesForVerification(rows: ExpenseRow[]): Map<string, Balance> {
  const out = new Map<string, Balance>();
  for (const [, list] of groupByUser(rows)) {
    const sorted = chronological(list);
    const total = sorted.reduce((s, e) => s + num(e.total_amount), 0);
    let run = num(sorted[0]?.user_balance) + total;
    for (const e of sorted) {
      const closing = run - num(e.total_amount);
      out.set(e.id, { opening: run, closing });
      run = closing;
    }
  }
  return out;
}

/**
 * Approval: approved amounts are already reflected in the balance, so the walk
 * runs backwards from it. Port of computeRowBalancesForApproval.
 */
export function balancesForApproval(rows: ExpenseRow[]): Map<string, Balance> {
  const out = new Map<string, Balance>();
  for (const [, list] of groupByUser(rows)) {
    const sorted = chronological(list);
    let run = num(sorted[0]?.user_balance);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const e = sorted[i];
      const opening = run + num(e.total_amount);
      out.set(e.id, { opening, closing: run });
      run = opening;
    }
  }
  return out;
}

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Record<string, string | number>[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/**
 * Integrity guard between "rows built" and "bytes about to be uploaded".
 * The CSV must start with exactly this report's own header line, and must
 * contain at least one physical line per data row (a quoted cell may add
 * more, never fewer). Throws with a safe message on any mismatch.
 */
export function assertCsvMatchesRows(csv: string, headers: string[], rowCount: number): void {
  const expectedHeader = "﻿" + headers.map(csvCell).join(",");
  if (!csv.startsWith(expectedHeader)) {
    throw new Error("Report file integrity check failed: header mismatch.");
  }
  const physicalLines = csv.split("\r\n").filter((l) => l.length > 0).length - 1;
  if (physicalLines < rowCount) {
    throw new Error(`Report file integrity check failed: expected at least ${rowCount} data lines, found ${physicalLines}.`);
  }
}

/** Page every matching expense. The completeness check is the caller's. */
export async function fetchAllExpenseRows(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  args: {
    organizationId: string;
    statuses: string[] | null;
    category: string | null;
    userIds: string[] | null;
    dateFrom: string | null;
    dateTo: string | null;
    sortColumn: "created_at" | "trip_start";
  },
  onProgress?: (received: number, total: number | null) => Promise<void>,
  deadline?: () => boolean,
): Promise<{ rows: ExpenseRow[]; total: number | null; pages: number }> {
  const rows: ExpenseRow[] = [];
  let cursor: unknown = null;
  let total: number | null = null;
  let pages = 0;

  for (;;) {
    if (deadline?.()) throw new Error(REPORT_TOO_LARGE_MESSAGE);

    const { data, error } = await svc.rpc("report_expense_rows_v1", {
      p_organization_id: args.organizationId,
      p_statuses: args.statuses,
      p_category: args.category,
      p_user_ids: args.userIds,
      p_date_from: args.dateFrom,
      p_date_to: args.dateTo,
      p_sort_column: args.sortColumn,
      p_cursor: cursor,
      p_page_size: PAGE_SIZE,
      p_with_total: pages === 0,
    });
    if (error) throw new Error(`page ${pages + 1}: ${error.message}`);

    const p = data as Record<string, unknown>;
    if (Number(p.schema_version) !== 1) {
      throw new Error(`Report contract version ${String(p.schema_version)} is not supported`);
    }
    if (pages === 0) total = p.total_count == null ? null : Number(p.total_count);

    for (const r of (p.rows ?? []) as ExpenseRow[]) rows.push(r);
    pages += 1;
    await onProgress?.(rows.length, total);

    if (!p.has_more || !p.next_cursor) break;
    cursor = p.next_cursor;
  }

  return { rows, total, pages };
}

const CLAIM_HEADERS_FIXED = [
  "User", "Employee ID", "Employee Email", "Transaction #", "Title", "Purpose",
  "Destination", "Batch", "Expense Type", "LPO Number", "Bill Date (DD-MM-YYYY)",
  "Trip End (DD-MM-YYYY)", "Bill Amount", "Status", "Manager Approval",
  "HO Approval", "Submitted On (DD-MM-YYYY)",
];

/** Claim Verification and Claim Approval differ only in the HO Approval cell. */
export function buildClaimCsv(
  rows: ExpenseRow[],
  kind: "claim_verification" | "claim_approval",
): { csv: string; rowCount: number } {
  const keys = customKeys(rows);
  const headers = [...CLAIM_HEADERS_FIXED, ...keys, "Opening Balance", "Closing Balance"];
  const balances = kind === "claim_verification"
    ? balancesForVerification(rows)
    : balancesForApproval(rows);
  const hoApproval = kind === "claim_verification" ? "Pending" : "Approved";

  const out = rows.map((e) => {
    const bal = balances.get(e.id) ?? { opening: 0, closing: 0 };
    const row: Record<string, string | number> = {
      "User": e.user_name,
      "Employee ID": e.employee_id || "",
      "Employee Email": e.user_email,
      "Transaction #": e.transaction_number || "",
      "Title": e.title || "",
      "Purpose": e.purpose || "",
      "Destination": e.destination || "",
      "Batch": e.batch_ref,
      "Expense Type": e.category || "-",
      "LPO Number": "-",
      "Bill Date (DD-MM-YYYY)": formatDDMMYYYY(e.trip_start),
      "Trip End (DD-MM-YYYY)": formatDDMMYYYY(e.trip_end),
      "Bill Amount": formatINR(num(e.total_amount)),
      "Status": e.status || "",
      "Manager Approval": "Verified",
      "HO Approval": hoApproval,
      "Submitted On (DD-MM-YYYY)": formatDDMMYYYY(e.created_at),
      "Opening Balance": formatINR(bal.opening),
      "Closing Balance": formatINR(bal.closing),
    };
    for (const k of keys) row[k] = e.custom_fields?.[k] ?? "";
    return row;
  });

  return { csv: toCsv(headers, out), rowCount: out.length };
}

/* ==========================================================================
 * Detailed Expense — canonical Additive V3 accounting ledger.
 *
 * This replaces a second, older accounting algorithm that lived here:
 *
 *   single employee : approved expenses + cash_transfer_history allocations,
 *                     balances walked BACKWARDS from rows[0].user_balance
 *   all employees   : approved expenses only, Debit column only, no closing
 *                     balance at all
 *
 * That predated Additive Credit V3 and could not see V3 positive or negative
 * balance entries, opening-balance credits, Tally/balance additions, or the
 * V3 reversed-pair visibility rules.
 *
 * Everything below now consumes report_balance_timeline_rows_v3, which is
 * built on the SAME canonical event set as the V3 Balance Ledger. No balance
 * is computed in TypeScript any more: Credit/Debit come from the sign of
 * amount_delta, and Opening/Closing come from the server's
 * calculated_balance_after. There is exactly one accounting algorithm and it
 * lives in SQL.
 * ========================================================================== */

/** One canonical balance event, as returned by report_balance_timeline_rows_v3. */
export interface BalanceTimelineRow {
  user_id: string;
  employee_name: string;
  employee_code: string;
  event_id: string;
  event_type: string;
  /** Human label, already resolved server-side (\"Expense Deduction\", \"Balance Credit\", ...). */
  event_label: string;
  effective_date: string;
  amount_delta: number | string;
  /** Positive magnitude, or null when this event is not a credit. */
  credit: number | string | null;
  /** Positive magnitude, or null when this event is not a debit. */
  debit: number | string | null;
  opening_balance: number | string;
  closing_balance: number | string;
  note: string;
  actor_name: string;
  /** TEXT end to end — leading zeros must survive into the file. */
  transaction_number: string;
  expense_id: string | null;
  title: string;
  category: string;
  purpose: string;
  destination: string;
  batch_ref: string;
  custom_fields: Record<string, string>;
  /**
   * V4 only (report_detailed_expense_rows_v4): whether this expense row has a
   * real expense_balance_deductions record. false means it is a legacy
   * approved expense V3 could never see -- shown for visibility, but its
   * balance delta is 0 (see the V4 migration's file header for why). Absent
   * entirely on rows from report_balance_timeline_rows_v3 (V3) or on any
   * non-expense event.
   */
  modern_deduction_present?: boolean;
}

/** Union of custom-field labels across timeline rows, ordered like the expense reports. */
export function timelineCustomKeys(rows: BalanceTimelineRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.custom_fields ?? {})) keys.add(k);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * Page the whole canonical timeline via either the V3 or V4 row producer --
 * same cursor/page/total contract on both, so the paging loop itself is
 * shared rather than duplicated. One set-based RPC per page over every
 * requested employee — never one call per employee. "All employees" on a
 * large organisation would otherwise be hundreds of round trips.
 */
async function fetchAllTimelineRowsViaRpc(
  rpcName: "report_balance_timeline_rows_v3" | "report_detailed_expense_rows_v4",
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  args: {
    organizationId: string;
    userIds: string[] | null;
    dateFrom: string | null;
    dateTo: string | null;
  },
  onProgress?: (received: number, total: number | null) => Promise<void>,
  deadline?: () => boolean,
): Promise<{ rows: BalanceTimelineRow[]; total: number | null; pages: number }> {
  const rows: BalanceTimelineRow[] = [];
  let cursor: unknown = null;
  let total: number | null = null;
  let pages = 0;

  for (;;) {
    if (deadline?.()) throw new Error(REPORT_TOO_LARGE_MESSAGE);

    const { data, error } = await svc.rpc(rpcName, {
      p_organization_id: args.organizationId,
      p_user_ids: args.userIds,
      p_date_from: args.dateFrom,
      p_date_to: args.dateTo,
      p_cursor: cursor,
      p_page_size: rpcName === "report_detailed_expense_rows_v4" ? DETAILED_PAGE_SIZE : PAGE_SIZE,
      p_with_total: pages === 0,
    });
    if (error) throw new Error(`timeline page ${pages + 1}: ${error.message}`);

    const p = data as Record<string, unknown>;
    if (Number(p.schema_version) !== 1) {
      throw new Error(`Report contract version ${String(p.schema_version)} is not supported`);
    }
    if (pages === 0) total = p.total_count == null ? null : Number(p.total_count);

    for (const r of (p.rows ?? []) as BalanceTimelineRow[]) rows.push(r);
    pages += 1;
    await onProgress?.(rows.length, total);

    if (!p.has_more || !p.next_cursor) break;
    cursor = p.next_cursor;
  }

  return { rows, total, pages };
}

/** V3 -- kept for any caller that still wants the modern-deduction-only event set. */
export async function fetchAllBalanceTimelineRows(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  args: { organizationId: string; userIds: string[] | null; dateFrom: string | null; dateTo: string | null },
  onProgress?: (received: number, total: number | null) => Promise<void>,
  deadline?: () => boolean,
): Promise<{ rows: BalanceTimelineRow[]; total: number | null; pages: number }> {
  return fetchAllTimelineRowsViaRpc("report_balance_timeline_rows_v3", svc, args, onProgress, deadline);
}

/**
 * V4 -- Detailed Expense only. Every APPROVED, valid-profile expense is a
 * row, whether or not it has a modern expense_balance_deductions record
 * (V3 could only ever see the modern subset). See the
 * report_detailed_expense_rows_v4 migration for the full rationale.
 */
export async function fetchAllDetailedExpenseRowsV4(
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  args: { organizationId: string; userIds: string[] | null; dateFrom: string | null; dateTo: string | null },
  onProgress?: (received: number, total: number | null) => Promise<void>,
  deadline?: () => boolean,
): Promise<{ rows: BalanceTimelineRow[]; total: number | null; pages: number }> {
  return fetchAllTimelineRowsViaRpc("report_detailed_expense_rows_v4", svc, args, onProgress, deadline);
}

/** Blank rather than "₹0.00" when the event does not touch this column at all. */
function money(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  return formatINR(num(v));
}

/**
 * Detailed Expense row model — the ONE canonical schema for both "All
 * employees" and a single selected employee.
 *
 * Both shapes are real accounting ledgers built off the same
 * report_balance_timeline_rows_v3 event set — every employee gets their OWN
 * independent running balance, computed per employee server-side, so there
 * is never one organisation-wide balance. Employee/Employee ID are always
 * present, including in single-employee mode: selecting one employee filters
 * the DATASET only, it must never change the report's column schema (DOC-131
 * format-parity fix — a prior version dropped these two columns when
 * `singleUserId` was set; that silently made "All employees" and "Employee =
 * X" two different formats, which is exactly what this fixes).
 *
 * This is the single source that both the CSV writer and the on-page preview
 * (report_export_job_rows, stored verbatim from `rows` below) consume, so
 * preview and download can never drift from each other — they are the same
 * computed objects, not two independent derivations.
 */
export function buildDetailedRows(
  rows: BalanceTimelineRow[],
): { headers: string[]; rows: Record<string, string>[] } {
  const keys = timelineCustomKeys(rows);
  const headers = [
    "Employee",
    "Employee ID",
    "Date",
    "Transaction #",
    "Title",
    "Type",
    "Expense Type",
    "Purpose",
    "Destination",
    "Batch",
    ...keys,
    "Credit",
    "Debit",
    "Notes",
    "Opening Balance",
    "Closing Balance",
  ];

  const out = rows.map((r) => {
    const row: Record<string, string> = {
      "Employee": r.employee_name ?? "",
      "Employee ID": r.employee_code ?? "",
      "Date": formatDDMMYYYY(r.effective_date),
      // Kept as text so a transaction number like "00496" does not lose its
      // leading zeros on the way into the file.
      "Transaction #": r.transaction_number ?? "",
      "Title": r.title ?? "",
      // The canonical event label, not a raw internal enum.
      "Type": r.event_label ?? "",
      // The expense's own category. Blank on non-expense balance events.
      "Expense Type": r.category ?? "",
      "Purpose": r.purpose ?? "",
      "Destination": r.destination ?? "",
      "Batch": r.batch_ref ?? "",
      // Sign decides the column; the event type never does.
      "Credit": money(r.credit),
      "Debit": money(r.debit),
      "Notes": r.note ?? "",
      "Opening Balance": money(r.opening_balance),
      "Closing Balance": money(r.closing_balance),
    };
    // Expense rows carry their custom fields; balance events leave them blank.
    for (const k of keys) row[k] = r.custom_fields?.[k] ?? "";
    return row;
  });

  return { headers, rows: out };
}

/** Thin CSV wrapper over buildDetailedRows — kept for callers that only need the file body. */
export function buildDetailedCsv(
  rows: BalanceTimelineRow[],
): { csv: string; rowCount: number } {
  const { headers, rows: out } = buildDetailedRows(rows);
  return { csv: toCsv(headers, out), rowCount: out.length };
}

/**
 * Detailed Expense presentation filters (Expense Type / custom fields).
 *
 * These narrow which rows APPEAR in the report -- they must never affect how
 * Opening/Closing Balance were computed. report_balance_timeline_rows_v3 is
 * always fetched for the FULL date-windowed timeline first (every event, own
 * running balance already resolved server-side); this filter runs afterward,
 * in memory, over that already-correct row set. A hidden expense's financial
 * effect already happened and stays baked into every later balance -- only
 * its own row disappears from the visible ledger.
 *
 * Only `event_type === 'expense_deduction'` rows are ever excluded. Balance
 * credits/additions/openers etc. have no category or custom fields of their
 * own (blank by construction) and must remain visible regardless of the
 * filter, or the ledger would look like money appeared/vanished with no
 * explanation -- this mirrors the pre-existing client behavior, where the
 * category filter narrowed the EXPENSES query only and the separate
 * cash-transfer/credit history was always unfiltered.
 */
export function matchesDetailedExpenseFilters(
  row: BalanceTimelineRow,
  category: string | null,
  customFieldFilters: Record<string, string> | null | undefined,
): boolean {
  if (row.event_type !== "expense_deduction") return true;
  if (category && String(row.category ?? "") !== category) return false;
  if (customFieldFilters) {
    for (const [key, wanted] of Object.entries(customFieldFilters)) {
      if (!wanted || wanted === "all") continue;
      const actual = String(row.custom_fields?.[key] ?? "").trim();
      if (actual !== wanted) return false;
    }
  }
  return true;
}

/** Filesystem/URL-safe, keeps letters in any script (Unicode names stay readable). */
export function sanitizeFilenamePart(raw: string): string {
  const cleaned = raw
    .normalize("NFC")
    // deno-lint-ignore no-control-regex
    // eslint-disable-next-line no-control-regex -- intentional: strips control chars from a filename
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/\.\./g, "")
    .trim()
    .replace(/\s+/g, "-");
  return cleaned.slice(0, 80) || "Employee";
}

/**
 * Detailed Expense filename: identifies WHO (employee, or "All-Employees")
 * and the actual requested report date range -- never today's generation
 * date. `dateFrom`/`dateTo` are the same values already sent to
 * report_balance_timeline_rows_v3, so the filename always matches what the
 * report itself covers.
 */
export function buildDetailedExpenseFilename(args: {
  singleUserId: string | null;
  employeeName: string | null;
  employeeCode: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}): string {
  const who = args.singleUserId
    ? sanitizeFilenamePart(args.employeeName || args.employeeCode || "Employee")
    : "All-Employees";
  const range = args.dateFrom && args.dateTo
    ? `${formatDDMMYYYY(args.dateFrom)}_to_${formatDDMMYYYY(args.dateTo)}`
    : "all-time";
  return `${who}_${range}.csv`;
}
