import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseFormDraftPayload } from "@/lib/expenseFormDraft";
import type { SubmittedExpenseBackup, SubmittedExpenseBackupStatus } from "@/lib/expenseSubmittedBackup";

const DRAFT_RETENTION_DAYS = 7;

export type ExpenseSubmissionDraftRow = {
  id: string;
  user_id: string;
  organization_id: string;
  source_expense_id: string | null;
  submission_status: SubmittedExpenseBackupStatus;
  title: string | null;
  destination: string | null;
  trip_start: string | null;
  total_amount: number | null;
  category: string | null;
  payload: ExpenseFormDraftPayload;
  expires_at: string;
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
};

function expirationIso(): string {
  return new Date(Date.now() + DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function tripStartFromPayload(payload: ExpenseFormDraftPayload): string | null {
  const raw = payload.expense.expense_date;
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export async function saveExpenseSubmissionDraft(
  supabase: SupabaseClient,
  params: {
    userId: string;
    organizationId: string;
    expenseId?: string | null;
    submissionStatus: SubmittedExpenseBackupStatus;
    payload: ExpenseFormDraftPayload;
  },
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { userId, organizationId, expenseId, submissionStatus, payload } = params;
  const expense = payload.expense;

  const row = {
    user_id: userId,
    organization_id: organizationId,
    source_expense_id: expenseId ?? null,
    submission_status: submissionStatus,
    title: expense.title?.trim() || null,
    destination: expense.destination?.trim() || null,
    trip_start: tripStartFromPayload(payload),
    total_amount: Number.isFinite(Number(expense.amount)) ? Number(expense.amount) : null,
    category: expense.category?.trim() || null,
    payload,
    expires_at: expirationIso(),
    dismissed_at: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("expense_submission_drafts")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, id: data?.id };
}

export async function listExpenseSubmissionDrafts(
  supabase: SupabaseClient,
  userId: string,
  organizationId: string,
): Promise<{ rows: ExpenseSubmissionDraftRow[]; error: string | null }> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("expense_submission_drafts")
    .select("*")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .is("dismissed_at", null)
    .gt("expires_at", now)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return { rows: [], error: error.message };
  }

  return { rows: (data ?? []) as ExpenseSubmissionDraftRow[], error: null };
}

export async function dismissExpenseSubmissionDraft(
  supabase: SupabaseClient,
  draftId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("expense_submission_drafts")
    .update({
      dismissed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId);

  return !error;
}

export function serverDraftToSubmittedBackup(
  row: ExpenseSubmissionDraftRow,
): SubmittedExpenseBackup {
  return {
    v: 1,
    localId: row.id,
    savedAt: row.created_at,
    expiresAt: row.expires_at,
    expenseId: row.source_expense_id,
    submissionStatus: row.submission_status,
    payload: row.payload,
  };
}
