/**
 * DOC-107 — admin submits an expense on behalf of an employee.
 *
 * Thin wrapper around admin_submit_expense_for_employee_v1. All authorization,
 * validation and hierarchy routing happen inside that SECURITY DEFINER RPC —
 * this file does no business logic of its own.
 */
import { supabase } from "@/integrations/supabase/client";
import type { ExpenseCustomFieldValuePayload } from "@/lib/expenseFormFieldPayload";
import { ExpenseService } from "@/services/ExpenseService";

/**
 * `src/integrations/supabase/types.ts` predates this RPC, so the typed client
 * rejects it by name. Narrow, commented escape; matches the existing pattern
 * in AuthContext.tsx and src/lib/reportExportJobs.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface AdminSubmitExpenseInput {
  organizationId: string;
  employeeId: string;
  title: string;
  destination: string;
  tripStart: string; // YYYY-MM-DD
  tripEnd: string; // YYYY-MM-DD
  category: string;
  amount: number;
  purpose?: string | null;
}

export interface AdminSubmitExpenseResult {
  expense_id: string;
  status: string;
  approval_tier: string | null;
  assigned_reviewer_id: string | null;
  assigned_engineer_id: string | null;
}

export async function submitExpenseForEmployee(
  input: AdminSubmitExpenseInput,
): Promise<AdminSubmitExpenseResult> {
  const { data, error } = await db.rpc("admin_submit_expense_for_employee_v1", {
    p_organization_id: input.organizationId,
    p_employee_id: input.employeeId,
    p_title: input.title,
    p_destination: input.destination,
    p_trip_start: input.tripStart,
    p_trip_end: input.tripEnd,
    p_category: input.category,
    p_amount: input.amount,
    p_purpose: input.purpose ?? null,
  });
  if (error) throw new Error(error.message);
  return data as AdminSubmitExpenseResult;
}

/**
 * Org-accurate custom fields follow-up.
 *
 * Deliberately a SEPARATE call from submitExpenseForEmployee, not a param
 * added to that RPC — mirrors the exact pattern ExpenseService.submitExpenseBatch
 * already uses (create expense, then separately replace_expense_form_field_values).
 * That RPC's own authorization already permits an org admin to write custom-field
 * values for ANY expense in their org (verified by reading its source: the
 * v_is_admin check is independent of e.user_id) — no new RPC needed.
 *
 * Known gap this call sits behind, by design, not by oversight: the expense is
 * already created (status=submitted, reviewer already notified) by the time this
 * runs, and replace_expense_form_field_values does not itself enforce
 * required-ness — only the client does, before calling it. A required custom
 * field can end up permanently missing if this call fails and is never retried.
 * Callers MUST treat a failure here as a distinct "created but incomplete" state,
 * never fold it into plain success — see Documentations MD/admin-submit-expense-for-employee.md.
 */
export async function saveExpenseCustomFields(
  organizationId: string,
  expenseId: string,
  values: ExpenseCustomFieldValuePayload[],
): Promise<void> {
  if (values.length === 0) return;
  const { error } = await db.rpc("replace_expense_form_field_values", {
    p_expense_id: expenseId,
    p_organization_id: organizationId,
    p_values: values,
  });
  if (error) throw new Error(error.message);
}

/**
 * Status the admin chooses at submit time — "submitted" is today's only
 * behavior; "verified"/"approved" reuse the exact same RPCs/methods the
 * reviewer queue already uses for an org-admin to bypass the hierarchy, not
 * new status-transition logic.
 */
export type AdminSubmitStatusChoice = "submitted" | "verified" | "approved";

const SELF_APPROVAL_MARKER = "[Admin self-approved own submission-on-behalf-of]";

/**
 * The admin choosing this page's status is always the same admin who just
 * created the expense (created_by_admin_id) — this marker makes that fact
 * greppable in audit_logs.comment / visible in the History detail drawer,
 * rather than indistinguishable from an ordinary reviewer approval.
 */
function buildStatusTransitionComment(userComment: string | null | undefined): string {
  const trimmed = (userComment ?? "").trim();
  return trimmed ? `${SELF_APPROVAL_MARKER} ${trimmed}` : SELF_APPROVAL_MARKER;
}

/**
 * Applies the admin's chosen status to an already-created expense.
 *
 * MUST be called only after any custom-field save for this expense has
 * already succeeded (or had nothing to save) — never before, never
 * concurrently. Calling this on a row whose required custom fields are
 * still missing would let "Approved" trigger the atomic balance deduction
 * (review_approve_expense_v2) on data known to be incomplete. Callers own
 * this sequencing; this function does not check custom-field state itself.
 *
 * "verified" -> ExpenseService.adminVerifyExpense: org-admin bypass of the
 * reviewer hierarchy, status submitted/edited -> verified, no balance
 * movement. "approved" -> ExpenseService.approveExpense: the SAME method
 * the reviewer-queue Approve button calls; its admin branch auto-verifies
 * from submitted/edited server-side inside the same transaction as the
 * atomic profiles.balance deduction (expense_balance_deductions,
 * UNIQUE(expense_id) — structurally prevents double-deduction). Both are
 * existing, already-audited, already-production-proven code paths — this
 * function is pure composition, zero new business logic.
 */
export async function applyAdminSubmitStatusChoice(
  status: AdminSubmitStatusChoice,
  expenseId: string,
  adminUserId: string,
  organizationId: string,
  userComment?: string | null,
): Promise<void> {
  if (status === "submitted") return;
  const comment = buildStatusTransitionComment(userComment);
  if (status === "verified") {
    await ExpenseService.adminVerifyExpense(expenseId, adminUserId, organizationId, comment);
  } else {
    await ExpenseService.approveExpense(expenseId, adminUserId, comment);
  }
}

/** One CSV/Excel row, already parsed and validated client-side. */
export interface BulkExpenseSubmitRow {
  rowIndex: number;
  employeeId?: string | null;
  email?: string | null;
  title: string;
  destination: string;
  tripStart: string; // YYYY-MM-DD
  tripEnd: string; // YYYY-MM-DD
  category: string;
  amount: number;
  purpose?: string | null;
}

export interface BulkExpenseRowResult {
  row_index: number;
  ok: boolean;
  expense_id?: string;
  error?: string;
}

/**
 * DOC-108 — chunks rows at BULK_SUBMIT_CHUNK_SIZE and calls
 * admin_bulk_submit_expenses_v1 once per chunk (server rejects > 250 rows in
 * one call). Sequential, not parallel: `onChunkComplete` lets the caller show
 * progress, and keeping chunks sequential means a transient failure only ever
 * loses the rows in the one chunk in flight, not the whole import.
 */
export async function submitBulkExpensesForEmployees(
  organizationId: string,
  rows: BulkExpenseSubmitRow[],
  chunkSize: number,
  onChunkComplete?: (completed: number, total: number) => void,
): Promise<BulkExpenseRowResult[]> {
  const results: BulkExpenseRowResult[] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const payload = chunk.map((r) => ({
      row_index: r.rowIndex,
      employee_id: r.employeeId || null,
      email: r.email || null,
      title: r.title,
      destination: r.destination,
      trip_start: r.tripStart,
      trip_end: r.tripEnd,
      category: r.category,
      amount: r.amount,
      purpose: r.purpose || null,
    }));

    const { data, error } = await db.rpc("admin_bulk_submit_expenses_v1", {
      p_organization_id: organizationId,
      p_rows: payload,
    });
    if (error) {
      // The whole chunk failed before any row-level result — surface it as a
      // failure for every row in that chunk rather than losing the information.
      for (const r of chunk) {
        results.push({ row_index: r.rowIndex, ok: false, error: error.message });
      }
    } else {
      const chunkResults = (data as { results?: BulkExpenseRowResult[] })?.results ?? [];
      results.push(...chunkResults);
    }
    onChunkComplete?.(Math.min(i + chunkSize, rows.length), rows.length);
  }
  return results;
}
