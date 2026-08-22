/**
 * DOC-105 — server-side builders for Claim Verification, Claim Approval and
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

/** Page every matching expense. The completeness check is the caller's. */
export async function fetchAllExpenseRows(
  // deno-lint-ignore no-explicit-any
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
    if (deadline?.()) throw new Error(`Exceeded soft deadline after ${pages} pages`);

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

export interface AllocationRow {
  id: string;
  transferred_at: string;
  amount: number;
  transfer_type: string;
  notes: string | null;
  transferrer_id: string;
  recipient_id: string;
}

/**
 * Detailed Expense.
 *
 * With one employee selected the client shows a ledger: allocations as credits,
 * expenses as debits, ordered by date with a running balance. With "All
 * employees" there is no single wallet to walk, so it degrades to a flat list —
 * the same split the UI makes via showDetailedBalanceColumns.
 */
export function buildDetailedCsv(
  rows: ExpenseRow[],
  allocations: AllocationRow[],
  singleUserId: string | null,
  closingBalance: number,
): { csv: string; rowCount: number } {
  const keys = customKeys(rows);

  if (!singleUserId) {
    const headers = [
      "Employee", "Employee ID", "Bill Date", "Title", "Type of Expense",
      "Purpose", "Destination", "Batch", ...keys, "Credit", "Debit", "Notes",
    ];
    const flat = [...rows].sort(
      (a, b) => new Date(a.trip_start).getTime() - new Date(b.trip_start).getTime(),
    );
    const out = flat.map((e) => {
      const row: Record<string, string | number> = {
        "Employee": e.user_name,
        "Employee ID": e.employee_id || "",
        "Bill Date": formatDDMMYYYY(e.trip_start),
        "Title": e.title || "",
        "Type of Expense": e.category || "-",
        "Purpose": e.purpose || "-",
        "Destination": e.destination || "-",
        "Batch": e.batch_ref,
        "Credit": "",
        "Debit": formatINR(num(e.total_amount)),
        "Notes": "",
      };
      for (const k of keys) row[k] = e.custom_fields?.[k] ?? "";
      return row;
    });
    return { csv: toCsv(headers, out), rowCount: out.length };
  }

  const headers = [
    "Bill Date", "Title", "Type of Expense", "Purpose", "Destination", "Batch",
    ...keys, "Credit", "Debit", "Notes", "Opening Balance", "Closing Balance",
  ];

  type Entry = {
    date: string; kind: "credit" | "debit"; title: string; category: string;
    purpose: string; destination: string; batch: string; amount: number;
    notes: string; custom: Record<string, string>;
  };

  const entries: Entry[] = [
    ...allocations.map((a): Entry => ({
      date: a.transferred_at,
      kind: a.recipient_id === singleUserId ? "credit" : "debit",
      title: "", category: a.transfer_type || "Allocation",
      purpose: "-", destination: "-", batch: "-",
      amount: num(a.amount), notes: a.notes ?? "", custom: {},
    })),
    ...rows.map((e): Entry => ({
      date: e.trip_start, kind: "debit", title: e.title || "",
      category: e.category || "-", purpose: e.purpose || "-",
      destination: e.destination || "-", batch: e.batch_ref,
      amount: num(e.total_amount), notes: "", custom: e.custom_fields ?? {},
    })),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // The client walks backward from the wallet's present balance, so the ledger
  // ends on the real number rather than an assumed opening of zero.
  let running = closingBalance;
  const withBalances = [...entries].reverse().map((e) => {
    const closing = running;
    const opening = e.kind === "credit" ? running - e.amount : running + e.amount;
    running = opening;
    return { e, opening, closing };
  }).reverse();

  const out = withBalances.map(({ e, opening, closing }) => {
    const row: Record<string, string | number> = {
      "Bill Date": formatDDMMYYYY(e.date),
      "Title": e.title,
      "Type of Expense": e.category,
      "Purpose": e.purpose,
      "Destination": e.destination,
      "Batch": e.batch,
      "Credit": e.kind === "credit" ? formatINR(e.amount) : "",
      "Debit": e.kind === "debit" ? formatINR(e.amount) : "",
      "Notes": e.notes,
      "Opening Balance": formatINR(opening),
      "Closing Balance": formatINR(closing),
    };
    for (const k of keys) row[k] = e.custom[k] ?? "";
    return row;
  });

  return { csv: toCsv(headers, out), rowCount: out.length };
}
