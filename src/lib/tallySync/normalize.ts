import type { TallySyncReportType } from "@/lib/tallyReportTypes";

export type NormalizedTallyItem = {
  organization_id: string;
  report_type: TallySyncReportType;
  source_type: string;
  source_id: string;
  payload: Record<string, unknown>;
};

export function normalizeExpenseRow(
  organizationId: string,
  reportType: TallySyncReportType,
  row: Record<string, unknown>,
): NormalizedTallyItem {
  const id = String(row.id);
  return {
    organization_id: organizationId,
    report_type: reportType,
    source_type: "expense",
    source_id: id,
    payload: {
      expense_id: id,
      user_id: row.user_id,
      employee_id: row.employee_id,
      user_name: row.user_name,
      status: row.status,
      category: row.category,
      total_amount: row.total_amount,
      trip_start: row.trip_start,
      trip_end: row.trip_end,
      purpose: row.purpose,
      destination: row.destination,
      transaction_number: row.transaction_number,
      batch_ref: row.batch_ref,
      custom_fields: row.custom_fields ?? {},
      opening_balance: row.opening_balance,
      closing_balance: row.closing_balance,
    },
  };
}

export function normalizeTimelineRow(
  organizationId: string,
  row: Record<string, unknown>,
): NormalizedTallyItem {
  const eventId = String(row.event_id);
  return {
    organization_id: organizationId,
    report_type: "detailed_expense",
    source_type: "balance_timeline",
    source_id: eventId,
    payload: {
      event_id: eventId,
      event_type: row.event_type,
      event_label: row.event_label,
      expense_id: row.expense_id,
      user_id: row.user_id,
      employee_name: row.employee_name,
      employee_code: row.employee_code,
      effective_date: row.effective_date,
      credit: row.credit,
      debit: row.debit,
      opening_balance: row.opening_balance,
      closing_balance: row.closing_balance,
      category: row.category,
      purpose: row.purpose,
      destination: row.destination,
      transaction_number: row.transaction_number,
      batch_ref: row.batch_ref,
      custom_fields: row.custom_fields ?? {},
      note: row.note,
      modern_deduction_present: row.modern_deduction_present,
    },
  };
}

export function normalizeDailyRow(
  organizationId: string,
  row: Record<string, unknown>,
): NormalizedTallyItem {
  const trackDate = String(row.track_date ?? "");
  const userId = String(row.user_id ?? "");
  const projectId = String(row.project_id ?? "");
  return {
    organization_id: organizationId,
    report_type: "daily_project_report",
    source_type: "daily_report_row",
    source_id: `${trackDate}|${userId}|${projectId}`,
    payload: {
      track_date: trackDate,
      user_id: userId,
      project_id: projectId,
      project_name: row.project_name,
      location: row.location,
      voucher_no: row.voucher_no,
      employee_name: row.employee_name,
      employee_code: row.employee_code,
      costs: row.costs,
      percent: row.percent,
      source_expenses: row.source_expenses,
      remarks: row.remarks,
    },
  };
}
