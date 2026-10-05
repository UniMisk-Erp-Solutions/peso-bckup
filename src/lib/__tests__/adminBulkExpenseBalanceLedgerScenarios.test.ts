/**
 * Balance-ledger scenario proof for the MicroLink bulk-expense-import audit
 * (hotfix/date-lock-and-tally-debit).
 *
 * There is no live Supabase/Postgres connection available in this static
 * audit environment, so this file cannot execute admin_bulk_submit_expenses_v2
 * / review_approve_expense_v2 against a real database. Instead it models the
 * exact arithmetic and guard rules those SQL functions implement — each rule
 * below cites the file:line it mirrors — and runs the specific numeric
 * scenarios requested for this audit against that model. This is a
 * faithfulness simulation, not a substitute for a real integration test; see
 * adminSubmitExpenseSqlContract.test.ts for the structural (regex-on-SQL-text)
 * proof that the live functions actually contain the rules modeled here.
 *
 * Rules modeled, each proven against the actual SQL in
 * adminSubmitExpenseSqlContract.test.ts's
 * "MicroLink bulk import — financial rules" describe block:
 *   - submitted/verified: zero balance effect
 *     (admin_submit_expense_for_employee_v2's status-transition branch only
 *     calls review_admin_verify_expense for 'verified'; no deduction call).
 *   - approved: balance_after = balance_before - total_amount, exactly once
 *     (supabase/migrations/20260808140000_atomic_expense_approval_balance_deduction.sql:202-213,
 *     UNIQUE(expense_id) at :45).
 *   - re-approving an already-approved expense / retrying an already-settled
 *     idempotency key never deducts twice
 *     (20260808140000...sql:148-150 status guard;
 *     20260828100000...sql:431-450 idempotency replay-before-any-write).
 *   - negative balances are allowed by design
 *     (20260808140000...sql:200-201 comment + no floor check on the UPDATE).
 */
import { describe, expect, it } from "vitest";

type Ledger = {
  balances: Map<string, number>;
  deductedExpenseIds: Set<string>; // mirrors expense_balance_deductions UNIQUE(expense_id)
  idempotencyKeys: Map<string, { expenseId: string; balanceAfter: number }>; // mirrors admin_submit_expense_idempotency PK
};

function newLedger(initialBalances: Record<string, number>): Ledger {
  return {
    balances: new Map(Object.entries(initialBalances)),
    deductedExpenseIds: new Set(),
    idempotencyKeys: new Map(),
  };
}

/**
 * Models admin_submit_expense_for_employee_v2 + review_approve_expense_v2
 * together: create an expense at the requested status, and -- only for
 * status='approved' -- perform the one-time, server-computed deduction.
 * Mirrors:
 *   - idempotency replay returning the ORIGINAL result without re-running
 *     anything (20260828100000...sql:437-449)
 *   - expense_balance_deductions UNIQUE(expense_id) making a second deduction
 *     for the same expense a hard failure (20260808140000...sql:45,215-225)
 */
function submitBulkRow(
  ledger: Ledger,
  row: {
    expenseId: string;
    employeeId: string;
    amount: number;
    status: "submitted" | "verified" | "approved";
    idempotencyKey: string;
  },
): { balanceAfter: number; deducted: boolean } {
  const replay = ledger.idempotencyKeys.get(row.idempotencyKey);
  if (replay) {
    // Same key => replay the original committed result; nothing re-runs.
    return { balanceAfter: ledger.balances.get(row.employeeId) ?? 0, deducted: false };
  }

  let balanceAfter = ledger.balances.get(row.employeeId) ?? 0;
  let deducted = false;

  if (row.status === "approved") {
    if (ledger.deductedExpenseIds.has(row.expenseId)) {
      throw new Error(
        `expense_balance_deductions_expense_key violated: expense ${row.expenseId} already deducted`,
      );
    }
    const before = ledger.balances.get(row.employeeId) ?? 0;
    balanceAfter = before - row.amount; // review_approve_expense_v2: balance = balance - v_amount, no floor
    ledger.balances.set(row.employeeId, balanceAfter);
    ledger.deductedExpenseIds.add(row.expenseId);
    deducted = true;
  }
  // submitted / verified: no balance touch at all.

  ledger.idempotencyKeys.set(row.idempotencyKey, { expenseId: row.expenseId, balanceAfter });
  return { balanceAfter, deducted };
}

describe("bulk-import balance ledger scenarios (simulates the proven SQL rules)", () => {
  it("status=submitted: current 7000, bulk amount 1000 -> balance unchanged at 7000", () => {
    const ledger = newLedger({ emp1: 7000 });
    const result = submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "submitted",
      idempotencyKey: "bulk:hash:0",
    });
    expect(result.deducted).toBe(false);
    expect(ledger.balances.get("emp1")).toBe(7000);
  });

  it("status=verified: current 7000, bulk amount 1000 -> balance unchanged at 7000", () => {
    const ledger = newLedger({ emp1: 7000 });
    const result = submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "verified",
      idempotencyKey: "bulk:hash:0",
    });
    expect(result.deducted).toBe(false);
    expect(ledger.balances.get("emp1")).toBe(7000);
  });

  it("status=approved: current 7000, bulk amount 1000 -> balance becomes 6000", () => {
    const ledger = newLedger({ emp1: 7000 });
    const result = submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "approved",
      idempotencyKey: "bulk:hash:0",
    });
    expect(result.deducted).toBe(true);
    expect(ledger.balances.get("emp1")).toBe(6000);
  });

  it("status=approved with insufficient balance: current 500, amount 1000 -> balance becomes -500 (negative balances are allowed by design)", () => {
    const ledger = newLedger({ emp1: 500 });
    const result = submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "approved",
      idempotencyKey: "bulk:hash:0",
    });
    expect(result.deducted).toBe(true);
    expect(ledger.balances.get("emp1")).toBe(-500);
  });

  it("retrying the SAME approved row (same clientOperationId) replays instead of deducting twice: still -500, never -1500", () => {
    const ledger = newLedger({ emp1: 500 });
    submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "approved",
      idempotencyKey: "bulk:hash:0",
    });
    expect(ledger.balances.get("emp1")).toBe(-500);

    // A retried upload of the same file reuses `bulk:<fileHash>:<rowIndex>`
    // as the idempotency key (BulkExpenseImportPanel.tsx), so this is the
    // exact key replayed on a resubmit.
    const retry = submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "approved",
      idempotencyKey: "bulk:hash:0",
    });
    expect(retry.deducted).toBe(false);
    expect(ledger.balances.get("emp1")).toBe(-500);
  });

  it("a second, DIFFERENT approved expense for the same employee deducts again (not blocked by the first's idempotency key): two distinct approvals, 7000 - 1000 - 500 = 5500", () => {
    const ledger = newLedger({ emp1: 7000 });
    submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "approved",
      idempotencyKey: "bulk:hash:0",
    });
    expect(ledger.balances.get("emp1")).toBe(6000);

    submitBulkRow(ledger, {
      expenseId: "exp-2",
      employeeId: "emp1",
      amount: 500,
      status: "approved",
      idempotencyKey: "bulk:hash:1",
    });
    expect(ledger.balances.get("emp1")).toBe(5500);
  });

  it("re-approving an already-deducted expense under a DIFFERENT idempotency key is refused (UNIQUE(expense_id) guard), never double-deducts", () => {
    const ledger = newLedger({ emp1: 7000 });
    submitBulkRow(ledger, {
      expenseId: "exp-1",
      employeeId: "emp1",
      amount: 1000,
      status: "approved",
      idempotencyKey: "bulk:hash:0",
    });
    expect(ledger.balances.get("emp1")).toBe(6000);

    // A different key targeting the SAME expense id -- e.g. a direct RPC call
    // bypassing the UI's stable key derivation -- must not be able to deduct
    // a second time.
    expect(() =>
      submitBulkRow(ledger, {
        expenseId: "exp-1",
        employeeId: "emp1",
        amount: 1000,
        status: "approved",
        idempotencyKey: "some-other-key",
      }),
    ).toThrow(/already deducted/);
    expect(ledger.balances.get("emp1")).toBe(6000);
  });
});
