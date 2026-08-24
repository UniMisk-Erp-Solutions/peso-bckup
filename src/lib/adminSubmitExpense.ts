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
