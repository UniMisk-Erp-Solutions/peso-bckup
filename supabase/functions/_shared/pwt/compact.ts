/**
 * The only report-row fields the planner reads (canonical.ts). The preparing worker keeps ONLY these in memory/RPC payloads, so a very
 * large report never needs the full rows again after they were stored in the immutable job snapshot.
 */
export const COMPACT_KEYS: readonly string[] = [
  "expense_id", "id", "Expense ID", "event_id", "transaction_number", "Transaction #", "event_type", "Type", "debit", "Debit", "credit", "Credit",
  "total_amount", "bill_amount", "Bill Amount", "amount", "status", "Status", "ho_approval", "HO Approval", "ho_status",
  "employee_code", "employee_id", "Employee ID", "Employee Code", "employee_name", "user_name", "Employee", "User",
  "category", "expense_type", "Expense Type", "effective_date", "bill_date", "trip_start", "Bill Date (DD-MM-YYYY)", "Date", "expense_date",
  "costs", "track_date", "user_id", "project_id", "voucher_no",
];
