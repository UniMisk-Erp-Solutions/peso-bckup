/**
 * DOC-089 — typed contract for `review_approve_expense_v2`.
 *
 * The RPC returns the financial truth the database actually committed. Nothing
 * here is recomputed in the browser: `before`, `deducted` and `after` come from
 * the locked profile row and the `RETURNING` clause of the balance UPDATE.
 *
 * Parsed defensively rather than cast with `as any`, so a contract mismatch
 * surfaces as a clear error instead of `undefined` arithmetic reaching the UI.
 */

export type ApprovalBalanceResult = {
  before: number;
  deducted: number;
  after: number;
};

export type ApprovalDeductionResult = {
  record_id: string | null;
  source: string;
};

export type ApproveExpenseV2Result = {
  ok: true;
  expense_id: string;
  /** Full expense row as committed; shape validated by the caller. */
  expense: Record<string, unknown> | null;
  comment: string | null;
  auto_verified: boolean;
  balance: ApprovalBalanceResult;
  deduction: ApprovalDeductionResult;
};

function asFiniteNumber(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(
      `Approval succeeded but the server returned no usable ${field}. ` +
        `Please refresh to confirm the current balance before approving again.`,
    );
  }
  return n;
}

/**
 * Validate the raw RPC payload.
 *
 * numeric columns arrive from PostgREST as strings often enough that coercion
 * is required — but only for values that are genuinely numeric. A missing or
 * malformed balance block is treated as an error, never silently as 0, because
 * a wrong balance shown after a real deduction is worse than a visible failure.
 */
export function parseApproveExpenseV2Result(raw: unknown): ApproveExpenseV2Result {
  if (!raw || typeof raw !== "object") {
    throw new Error("Approval failed: the server returned an empty response.");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.ok !== true) {
    throw new Error("Failed to approve expense");
  }

  const balanceRaw = obj.balance;
  if (!balanceRaw || typeof balanceRaw !== "object") {
    throw new Error(
      "Approval succeeded but the server returned no balance result. " +
        "Please refresh to confirm the current balance.",
    );
  }
  const b = balanceRaw as Record<string, unknown>;

  const deductionRaw = (obj.deduction ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    expense_id: String(obj.expense_id ?? ""),
    expense:
      obj.expense && typeof obj.expense === "object"
        ? (obj.expense as Record<string, unknown>)
        : null,
    comment: typeof obj.comment === "string" ? obj.comment : null,
    auto_verified: obj.auto_verified === true,
    balance: {
      before: asFiniteNumber(b.before, "balance before"),
      deducted: asFiniteNumber(b.deducted, "deducted amount"),
      after: asFiniteNumber(b.after, "balance after"),
    },
    deduction: {
      record_id:
        typeof deductionRaw.record_id === "string" ? deductionRaw.record_id : null,
      source: typeof deductionRaw.source === "string" ? deductionRaw.source : "approval",
    },
  };
}
