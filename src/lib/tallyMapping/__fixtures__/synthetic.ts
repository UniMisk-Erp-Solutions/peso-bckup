import type { PreparedJobItem } from "../types";

export const ORG_A = "11111111-1111-1111-1111-111111111111";
export const ORG_B = "22222222-2222-2222-2222-222222222222";
export const USER_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const EXP_E123 = "e1234567-89ab-cdef-0123-456789abcdef";
export const EVENT_X = "f1111111-1111-1111-1111-111111111111";
export const PROJECT_P1 = "p1111111-1111-1111-1111-111111111111";

const expenseRow = (overrides: Record<string, unknown> = {}) => ({
  id: EXP_E123,
  user_id: USER_1,
  user_name: "Ravi & Co <test>",
  employee_id: "EMP-001",
  title: "Site visit",
  total_amount: 1500.5,
  status: "verified",
  trip_start: "2026-03-15",
  category: "Travel",
  purpose: "Purpose with \"quotes\" & ampersands",
  destination: "Mumbai",
  transaction_number: "TX-99",
  batch_ref: "B-1",
  custom_fields: { "Project ID": "P-100", "नोट": "Unicode note" },
  ...overrides,
});

export function claimVerificationItem(hash = "hash-cv-1"): PreparedJobItem {
  return {
    seq: 1,
    source_type: "expense",
    source_key: `${ORG_A}:expense:${EXP_E123}`,
    content_hash: hash,
    payload: {
      organization_id: ORG_A,
      report_type: "claim_verification",
      expense_id: EXP_E123,
      payload: expenseRow(),
    },
  };
}

export function claimApprovalItem(hash = "hash-ca-1"): PreparedJobItem {
  return {
    seq: 2,
    source_type: "expense",
    source_key: `${ORG_A}:expense:${EXP_E123}`,
    content_hash: hash,
    payload: {
      organization_id: ORG_A,
      report_type: "claim_approval",
      expense_id: EXP_E123,
      payload: expenseRow({ status: "approved" }),
    },
  };
}

export function detailedExpenseDeductionItem(hash = "hash-de-1"): PreparedJobItem {
  return {
    seq: 3,
    source_type: "balance_timeline",
    source_key: `${ORG_A}:balance_event:${EVENT_X}`,
    content_hash: hash,
    payload: {
      organization_id: ORG_A,
      report_type: "detailed_expense",
      event_id: EVENT_X,
      payload: {
        event_id: EVENT_X,
        event_type: "expense_deduction",
        expense_id: EXP_E123,
        user_id: USER_1,
        employee_name: "Ravi & Co <test>",
        employee_code: "EMP-001",
        effective_date: "2026-03-15",
        debit: 1500.5,
        credit: null,
        opening_balance: 5000,
        closing_balance: 3499.5,
        category: "Travel",
        custom_fields: {},
      },
    },
  };
}

export function dailyProjectItem(hash = "hash-daily-1"): PreparedJobItem {
  return {
    seq: 4,
    source_type: "daily_report_row",
    source_key: `${ORG_A}:daily_row:2026-03-15|${USER_1}|${PROJECT_P1}`,
    content_hash: hash,
    payload: {
      organization_id: ORG_A,
      report_type: "daily_project_report",
      track_date: "2026-03-15",
      user_id: USER_1,
      project_id: PROJECT_P1,
      row: {
        track_date: "2026-03-15",
        user_id: USER_1,
        project_id: PROJECT_P1,
        project_name: "Highway Phase 2",
        location: "NH-48",
        employee_name: "Ravi",
        costs: { fuel: 800, toll: 200 },
        percent: { fuel: 80, toll: 20 },
        source_expenses: [{ id: EXP_E123, amount: 1000 }],
        remarks: "Aggregated row",
      },
    },
  };
}

export function balanceTransferItem(): PreparedJobItem {
  return {
    seq: 5,
    source_type: "balance_timeline",
    source_key: `${ORG_A}:balance_event:99999999-9999-9999-9999-999999999999`,
    content_hash: "hash-transfer",
    payload: {
      organization_id: ORG_A,
      report_type: "detailed_expense",
      event_id: "99999999-9999-9999-9999-999999999999",
      payload: {
        event_id: "99999999-9999-9999-9999-999999999999",
        event_type: "cash_transfer_in",
        user_id: USER_1,
        employee_name: "Ravi",
        effective_date: "2026-03-01",
        credit: 500,
        debit: null,
      },
    },
  };
}
