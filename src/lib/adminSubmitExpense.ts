/**
 * DOC-107 — admin submits an expense on behalf of an employee.
 *
 * Thin wrapper around admin_submit_expense_for_employee_v1. All authorization,
 * validation and hierarchy routing happen inside that SECURITY DEFINER RPC —
 * this file does no business logic of its own.
 */
import { supabase } from "@/integrations/supabase/client";

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
