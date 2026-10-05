/**
 * Admin submits an expense on behalf of an employee — service layer.
 *
 * Calls the atomic, idempotent admin_submit_expense_for_employee_v2 /
 * admin_bulk_submit_expenses_v2 RPCs (see
 * supabase/migrations/20260828100000_admin_submit_expense_for_employee_v2.sql
 * for the full architecture rationale). Receipt attachment is a separate,
 * best-effort, non-blocking step performed AFTER the atomic RPC succeeds —
 * the RPC itself never touches Storage or the attachments table, matching
 * the source feature's own deliberate design (there is no bill-photo gate on
 * this delegated path; only an admin can reach it at all).
 */
import { supabase } from "@/integrations/supabase/client";
import {
  invokeFinalizeExpenseReceipts,
  runWithConcurrency,
  type FinalizeReceiptsInput,
} from "@/lib/receiptFinalization";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type AdminSubmitStatusChoice = "submitted" | "verified" | "approved";

export type CustomFieldValuePayload = {
  template_id?: string | null;
  branch_field_id?: string | null;
  field_value: string;
};

export type AdminSubmitExpenseInput = {
  organizationId: string;
  employeeId: string;
  title: string;
  destination: string;
  tripStart: string;
  tripEnd: string;
  category: string;
  amount: number;
  purpose?: string | null;
  customFieldValues?: CustomFieldValuePayload[];
  status?: AdminSubmitStatusChoice;
  statusComment?: string | null;
  /** Deduplicates a retried submit (network timeout, double click). Required
   * for the bulk path; generate a fresh one per attempt for the single form. */
  idempotencyKey?: string | null;
};

export type AdminSubmitExpenseResult = {
  expenseId: string;
  status: string;
  approvalTier: string | null;
  assignedReviewerId: string | null;
  assignedEngineerId: string | null;
  customFieldsSaved: number;
  idempotentReplay: boolean;
};

export class AdminSubmitExpenseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdminSubmitExpenseError";
    this.code = code;
  }
}

/** Maps a raw Postgres error to one of Phase 30's error codes, never a generic string. */
function classifyRpcError(error: { message?: string; code?: string } | null | undefined): AdminSubmitExpenseError {
  const message = error?.message ?? "Unknown error";
  const lower = message.toLowerCase();
  if (error?.code === "28000" || lower.includes("authentication required")) {
    return new AdminSubmitExpenseError("UNAUTHENTICATED", message);
  }
  if (error?.code === "42501" || lower.includes("not permitted")) {
    return new AdminSubmitExpenseError("FORBIDDEN", message);
  }
  if (lower.includes("not an active member")) {
    return new AdminSubmitExpenseError("EMPLOYEE_NOT_FOUND", message);
  }
  // DOC-138 (expense date locking, hotfix 2026-10-01): both
  // admin_submit_expense_for_employee_v2 and admin_bulk_submit_expenses_v2
  // insert directly at status='submitted', so trg_enforce_expense_date_lock
  // (SQLSTATE PW010) rejects them exactly like any other submission on a
  // locked date once that trigger is deployed -- this just gives callers a
  // recognizable code instead of the generic EXPENSE_CREATE_FAILED fallback.
  // The trigger itself remains the real, unbypassable authority; this is
  // classification only, not a bypass or a new enforcement path.
  if (error?.code === "PW010" || lower.includes("expense date is closed")) {
    return new AdminSubmitExpenseError("EXPENSE_DATE_LOCKED", message);
  }
  if (lower.includes("accountant-cashier") || lower.includes("cashier expense submission")) {
    return new AdminSubmitExpenseError("EMPLOYEE_INACTIVE", message);
  }
  if (lower.includes("does not belong to this organization")) {
    return new AdminSubmitExpenseError("CROSS_ORG", message);
  }
  if (lower.includes("not valid for this expense category")) {
    return new AdminSubmitExpenseError("CATEGORY_INVALID", message);
  }
  if (lower.includes("exactly one of template_id") || lower.includes("duplicate") || lower.includes("must be a json array")) {
    return new AdminSubmitExpenseError("BRANCH_VALUE_INVALID", message);
  }
  if (error?.code === "23505" || lower.includes("idempotency key already used")) {
    return new AdminSubmitExpenseError("IDEMPOTENCY_CONFLICT", message);
  }
  if (
    lower.includes("title is required") ||
    lower.includes("destination is required") ||
    lower.includes("category is required") ||
    lower.includes("amount must be") ||
    lower.includes("expense date is required")
  ) {
    return new AdminSubmitExpenseError("REQUIRED_FIELD_MISSING", message);
  }
  return new AdminSubmitExpenseError("EXPENSE_CREATE_FAILED", message);
}

export async function submitExpenseForEmployee(
  input: AdminSubmitExpenseInput,
): Promise<AdminSubmitExpenseResult> {
  const { data, error } = await db.rpc("admin_submit_expense_for_employee_v2", {
    p_organization_id: input.organizationId,
    p_employee_id: input.employeeId,
    p_title: input.title,
    p_destination: input.destination,
    p_trip_start: input.tripStart,
    p_trip_end: input.tripEnd,
    p_category: input.category,
    p_amount: input.amount,
    p_purpose: input.purpose ?? null,
    p_custom_field_values: input.customFieldValues ?? [],
    p_status: input.status ?? "submitted",
    p_status_comment: input.statusComment ?? null,
    p_idempotency_key: input.idempotencyKey ?? null,
  });

  if (error) throw classifyRpcError(error);
  if (!data?.expense_id) {
    throw new AdminSubmitExpenseError("EXPENSE_CREATE_FAILED", "The server did not return a created expense.");
  }

  return {
    expenseId: data.expense_id,
    status: data.status,
    approvalTier: data.approval_tier ?? null,
    assignedReviewerId: data.assigned_reviewer_id ?? null,
    assignedEngineerId: data.assigned_engineer_id ?? null,
    customFieldsSaved: data.custom_fields_saved ?? 0,
    idempotentReplay: data.idempotent_replay === true,
  };
}

export type BulkSubmitRow = {
  rowIndex: number;
  employeeId?: string | null;
  email?: string | null;
  title: string;
  destination: string;
  tripStart: string;
  tripEnd: string;
  category: string;
  amount: number;
  purpose?: string | null;
  customFieldValues?: CustomFieldValuePayload[];
  status?: AdminSubmitStatusChoice;
  statusComment?: string | null;
  /** Stable per-row idempotency key — see BulkExpenseImportPanel for how
   * this is derived (file identity + row identity), so re-submitting the
   * same file after a partial failure never double-creates a succeeded row. */
  clientOperationId: string;
};

export type BulkSubmitRowResult = {
  rowIndex: number;
  ok: boolean;
  expenseId?: string;
  idempotentReplay?: boolean;
  error?: string;
};

/** Server hard-caps a single call at 250 rows; the client chunks below that. */
export const BULK_SUBMIT_CHUNK_SIZE = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function submitBulkExpensesForEmployees(
  organizationId: string,
  rows: BulkSubmitRow[],
): Promise<BulkSubmitRowResult[]> {
  const results: BulkSubmitRowResult[] = [];
  for (const batch of chunk(rows, BULK_SUBMIT_CHUNK_SIZE)) {
    const { data, error } = await db.rpc("admin_bulk_submit_expenses_v2", {
      p_organization_id: organizationId,
      p_rows: batch.map((row) => ({
        row_index: row.rowIndex,
        employee_id: row.employeeId ?? null,
        email: row.email ?? null,
        title: row.title,
        destination: row.destination,
        trip_start: row.tripStart,
        trip_end: row.tripEnd,
        category: row.category,
        amount: row.amount,
        purpose: row.purpose ?? null,
        custom_field_values: row.customFieldValues ?? [],
        status: row.status ?? "submitted",
        status_comment: row.statusComment ?? null,
        client_operation_id: row.clientOperationId,
      })),
    });
    if (error) throw classifyRpcError(error);
    for (const r of data?.results ?? []) {
      results.push({
        rowIndex: r.row_index,
        ok: r.ok === true,
        expenseId: r.expense_id ?? undefined,
        idempotentReplay: r.idempotent_replay === true,
        error: r.error ?? undefined,
      });
    }
  }
  return results;
}

/**
 * Best-effort, non-blocking receipt attachment for an already-created
 * expense. Mirrors ExpenseForm.tsx's own moveTempFilesToExpense: uploads to
 * temp/{adminUserId}/... during form-filling, then finalizes via the
 * finalize-expense-receipts Edge Function (now admin-aware — see
 * supabase/functions/finalize-expense-receipts/index.ts) into
 * {expenseId}/.... A finalization failure never rolls back or retries the
 * already-created, already-settled expense; the caller must surface the
 * distinct "receipt pending" state rather than reporting silent success.
 */
export async function finalizePendingReceiptsForExpense(params: {
  expenseId: string;
  organizationId: string;
  adminUserId: string;
  receipts: FinalizeReceiptsInput[];
  blobCache?: Map<string, Blob>;
}): Promise<{ finalizedCount: number; pendingCount: number; failedCount: number; attachmentsInserted: number }> {
  const { expenseId, organizationId, adminUserId, receipts, blobCache } = params;
  if (receipts.length === 0) {
    return { finalizedCount: 0, pendingCount: 0, failedCount: 0, attachmentsInserted: 0 };
  }

  const results = await invokeFinalizeExpenseReceipts(supabase, {
    expenseId,
    userId: adminUserId,
    receipts,
    blobCache,
  });

  let finalizedCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  let attachmentsInserted = 0;

  const tasks = results.map((result) => async () => {
    if (result.status === "failed" || !result.resolvedPath) {
      failedCount += 1;
      return;
    }
    if (result.status === "temporary_fallback") pendingCount += 1;
    else finalizedCount += 1;

    const { error } = await db.from("attachments").insert({
      expense_id: expenseId,
      organization_id: organizationId,
      file_url: result.fileUrl || "",
      filename: result.filename,
      uploaded_by: adminUserId,
      storage_path: result.resolvedPath,
    });
    // A metadata-write failure after a successful storage finalize is NOT
    // success: no attachment row means no evidence exists, regardless of
    // what Storage did. Counted as failed, never silently dropped.
    if (error) {
      failedCount += 1;
      if (result.status === "temporary_fallback") pendingCount -= 1;
      else finalizedCount -= 1;
    } else {
      attachmentsInserted += 1;
    }
  });

  await runWithConcurrency(tasks, 2);

  return { finalizedCount, pendingCount, failedCount, attachmentsInserted };
}
