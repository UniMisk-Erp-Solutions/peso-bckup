/**
 * MicroLink atomic expense persistence — the client half of V1.
 *
 * ONE mutating request per submit. No custom-field call, no status PATCH.
 *
 * The rules that matter, and why:
 *
 *  - A timeout is NOT a failure. The transaction may well have committed while
 *    the response was lost, so we ask the server what actually happened using
 *    the idempotency key we already sent, instead of guessing and telling the
 *    employee their expense became a draft.
 *
 *  - A retry reuses the SAME key. A new key would create a second expense with
 *    a second transaction number.
 *
 *  - Success is only ever declared on a server receipt, never on HTTP 200.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  MICROLINK_ORGANIZATION_ID,
  type MicroLinkExpenseSnapshotV1,
} from "@/lib/microlinkExpenseSnapshot";

/**
 * The single routing decision for the staged rollout. One place, resolved by
 * organization id — not by comparing a display name at each call site.
 */
export function usesAtomicSubmissionV1(organizationId: string | null | undefined): boolean {
  return !!organizationId && organizationId === MICROLINK_ORGANIZATION_ID;
}

export interface SubmissionReceipt {
  committed: true;
  replayed: boolean;
  expense_id: string;
  transaction_number: string | null;
  status: string;
  revision: number;
  submitted_at: string;
  snapshot_hash: string;
  persisted_core_fields: number;
  persisted_custom_fields: number;
  idempotency_key: string;
  // Response contract added with the action-scoped receipts migration
  // (20261007120000). Absent on responses from an older server, so every reader
  // must treat these as optional.
  requested_action?: ReceiptAction;
  receipt_action?: ReceiptAction;
  /** Canonical status of the expense row at response time (not the receipt's). */
  actual_status?: string;
  idempotency_result?: "executed" | "replayed";
}

export type ReceiptAction = "submit" | "save_draft" | "update_submitted";

type PersistFn =
  | "submit_microlink_expense_v1"
  | "save_microlink_expense_draft_v1"
  | "update_microlink_submitted_expense_v1";

const ACTION_BY_FN: Record<PersistFn, ReceiptAction> = {
  submit_microlink_expense_v1: "submit",
  save_microlink_expense_draft_v1: "save_draft",
  update_microlink_submitted_expense_v1: "update_submitted",
};

export type SubmissionOutcome =
  | { kind: "committed"; receipt: SubmissionReceipt }
  | { kind: "rejected"; code: string; message: string; conflict: boolean }
  | { kind: "unknown"; message: string };

/** Postgres error codes this feature raises deliberately. */
const CODE_MESSAGES: Record<string, string> = {
  PW001: "Some required details are missing.",
  PW002: "This project is not configured correctly. Please contact an administrator.",
  PW003: "The project details could not be validated. Reload the form and select the project again.",
  PW409: "This expense was changed in another session. Reload it before submitting.",
  // DOC-138 (expense date locking, hotfix 2026-10-01): trg_enforce_expense_date_lock
  // rejects submit_microlink_expense_v1/_batch_v1 exactly like any other submit
  // path once deployed. This is classification only (server message usually wins
  // below anyway) -- the trigger remains the real, unbypassable authority.
  PW010: "This expense date is closed for submission. An organization admin has locked this date range.",
  "23514": "Some required details are missing.",
  "42501": "You are not allowed to submit this expense.",
  "28000": "Your session has expired. Please sign in again.",
};

function describe(error: { code?: string; message?: string } | null): {
  code: string;
  message: string;
} {
  const code = error?.code ?? "unknown";
  const friendly = CODE_MESSAGES[code];
  // The server's own message is usually the most specific and actionable thing
  // we have ("Project Unique ID is required"), so it wins when present.
  return { code, message: error?.message?.trim() || friendly || "The expense was not submitted." };
}

/** True for the failure modes where the request may still have committed. */
function isAmbiguousTransportError(error: unknown): boolean {
  const e = error as { message?: string; code?: string; status?: number } | null;
  const msg = (e?.message ?? "").toLowerCase();
  const status = e?.status;
  return (
    status === 504 ||
    status === 502 ||
    status === 408 ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("connection") ||
    msg.includes("aborted")
  );
}

function rpc<T>(fn: string, args: Record<string, unknown>) {
  // The generated Supabase types do not carry these RPCs yet. `.bind` is
  // load-bearing: `supabase.rpc` reads `this`, so assigning it to a local
  // detaches it and the call throws before any request is sent.
  const call = (
    supabase.rpc as unknown as (
      name: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: T | null; error: { code?: string; message?: string } | null }>
  ).bind(supabase);
  return call(fn, args);
}

/**
 * Ask the server what happened to one submission attempt. Used after an
 * ambiguous transport failure, never to infer failure from silence.
 */
export async function lookupSubmissionResult(
  idempotencyKey: string,
  action?: ReceiptAction,
): Promise<SubmissionOutcome> {
  type Lookup = { committed: boolean; known: boolean } & SubmissionReceipt;
  // The receipt is identified by (key, action). Ask for the action we are
  // reconciling so a draft receipt can never stand in for a submit.
  let { data, error } = await rpc<Lookup>(
    "get_expense_submission_result_v1",
    action ? { p_idempotency_key: idempotencyKey, p_action: action } : { p_idempotency_key: idempotencyKey },
  );
  if (error && action && (error.code === "PGRST202" || error.code === "42883")) {
    // Server not yet on the action-aware lookup: fall back to the key-only form
    // and re-check the action on the receipt ourselves below.
    ({ data, error } = await rpc<Lookup>("get_expense_submission_result_v1", {
      p_idempotency_key: idempotencyKey,
    }));
  }
  if (error) {
    const d = describe(error);
    return { kind: "unknown", message: d.message };
  }
  if (data && data.committed) {
    // Defense in depth: never accept a receipt written for a different action.
    const stored = data.receipt_action;
    if (action && stored && stored !== action) {
      return { kind: "unknown", message: "The submission could not be confirmed yet." };
    }
    return { kind: "committed", receipt: { ...(data as SubmissionReceipt), replayed: true } };
  }
  // Not found. That is only meaningful once the request can no longer be in
  // flight; the caller decides, so we report "unknown" rather than "failed".
  return { kind: "unknown", message: "The submission could not be confirmed yet." };
}

async function persist(
  fn: PersistFn,
  snapshot: MicroLinkExpenseSnapshotV1,
): Promise<SubmissionOutcome> {
  const action = ACTION_BY_FN[fn];
  try {
    const { data, error } = await rpc<SubmissionReceipt>(fn, { p_snapshot: snapshot });

    if (error) {
      if (isAmbiguousTransportError(error)) {
        return lookupSubmissionResult(snapshot.idempotency_key, action);
      }
      const d = describe(error);
      return { kind: "rejected", code: d.code, message: d.message, conflict: d.code === "PW409" };
    }
    if (!data || data.committed !== true) {
      // HTTP said 200 but the application did not confirm. Never call that success.
      return lookupSubmissionResult(snapshot.idempotency_key, action);
    }
    return { kind: "committed", receipt: data };
  } catch (thrown) {
    if (isAmbiguousTransportError(thrown)) {
      return lookupSubmissionResult(snapshot.idempotency_key, action);
    }
    const d = describe(thrown as { code?: string; message?: string });
    return { kind: "rejected", code: d.code, message: d.message, conflict: d.code === "PW409" };
  }
}

/**
 * Returns `snapshot` carrying a different idempotency key.
 *
 * The server stores ONE receipt per key and answers any repeated key with that
 * stored receipt WITHOUT looking at the action it was written for
 * (`_persist_microlink_expense_snapshot_v1`, replay branch). The "attach first,
 * then submit" flow makes two calls for one logical attempt -- save_draft, then
 * submit. If both carry the same key, the submit is answered with the old
 * save_draft receipt (`status: "draft"`) and never runs, so the expense stays a
 * draft while the form reports success. The draft step therefore needs its own
 * key; each step still retries safely under its own.
 */
export function snapshotWithIdempotencyKey(
  snapshot: MicroLinkExpenseSnapshotV1,
  idempotencyKey: string,
): MicroLinkExpenseSnapshotV1 {
  return { ...snapshot, idempotency_key: idempotencyKey };
}

/**
 * A SUBMIT that the server confirmed as "committed" is only a submission if the
 * receipt says so. Returns the user-facing failure text when it does not (for
 * example a replayed draft receipt), or null when the expense really is
 * submitted. A committed-but-not-submitted receipt must never be reported as a
 * successful submission.
 */
export function unsubmittedReceiptMessage(
  receipt: Pick<SubmissionReceipt, "status"> &
    Partial<Pick<SubmissionReceipt, "actual_status" | "receipt_action">>,
): string | null {
  const stillDraft = receipt.actual_status === "draft";
  const wrongAction = !!receipt.receipt_action && receipt.receipt_action !== "submit";
  if (receipt.status === "submitted" && !stillDraft && !wrongAction) return null;
  return "Your expense was saved as a draft but was NOT submitted. Open it from My Expenses (Drafts) and submit it again.";
}

/**
 * Safe, enumerated facts about a SUBMIT whose receipt did not confirm a
 * submission (requested action, the action that wrote the receipt, the
 * canonical status). Used as monitoring tags; contains no ids or amounts.
 */
export function semanticMismatchTags(
  receipt: Pick<SubmissionReceipt, "status"> &
    Partial<Pick<SubmissionReceipt, "actual_status" | "receipt_action">>,
  requestedAction: ReceiptAction = "submit",
): { requestedAction: ReceiptAction; receiptAction: string; actualStatus: string } {
  return {
    requestedAction,
    receiptAction: receipt.receipt_action ?? "unknown",
    actualStatus: receipt.actual_status ?? receipt.status ?? "unknown",
  };
}

/** ONE request. Creates or updates, writes every field, and submits, atomically. */
export function submitMicroLinkExpense(
  snapshot: MicroLinkExpenseSnapshotV1,
): Promise<SubmissionOutcome> {
  return persist("submit_microlink_expense_v1", snapshot);
}

/** ONE request. Persists core + custom + branch values; may be incomplete. */
export function saveMicroLinkExpenseDraft(
  snapshot: MicroLinkExpenseSnapshotV1,
): Promise<SubmissionOutcome> {
  return persist("save_microlink_expense_draft_v1", snapshot);
}

/**
 * ONE request. Edits an ALREADY submitted expense in place: same expense id,
 * status, transaction number, approval tier and assigned reviewer/engineer.
 * Distinct from submitMicroLinkExpense on purpose — that path resolves
 * routing and logs a submission event, neither of which an in-place edit of
 * a submitted expense should do (matches the legacy client, which only calls
 * ExpenseService.updateExpense — never submitExpense — for a submitted edit).
 */
export function updateSubmittedMicroLinkExpense(
  snapshot: MicroLinkExpenseSnapshotV1,
): Promise<SubmissionOutcome> {
  return persist("update_microlink_submitted_expense_v1", snapshot);
}

export interface BatchOutcome {
  batch_valid: boolean;
  committed: boolean;
  submitted_count: number;
  submitted?: { index: number; receipt: SubmissionReceipt }[];
  failed: { index: number; sqlstate: string; message: string; title: string | null }[];
  hint?: string;
}

/**
 * Batch. All-or-none by default; `allowPartial` is the employee's explicit
 * second choice after being shown exactly which rows are blocked.
 */
export async function submitMicroLinkExpenseBatch(
  snapshots: MicroLinkExpenseSnapshotV1[],
  allowPartial = false,
): Promise<{ kind: "ok"; result: BatchOutcome } | { kind: "rejected"; message: string }> {
  const { data, error } = await rpc<BatchOutcome>("submit_microlink_expense_batch_v1", {
    p_snapshots: snapshots,
    p_allow_partial: allowPartial,
  });
  if (error) return { kind: "rejected", message: describe(error).message };
  if (!data) return { kind: "rejected", message: "The batch could not be submitted." };
  return { kind: "ok", result: data };
}

/**
 * §22 readback. Confirms the database really holds what the receipt claims,
 * rather than trusting the receipt alone. Returns the mismatched keys.
 */
export async function verifyPersistedExpense(
  receipt: SubmissionReceipt,
  expected: { status: string; transactionNumberPresent: boolean },
): Promise<string[]> {
  const mismatches: string[] = [];
  const { data, error } = await supabase
    .from("expenses")
    .select("id, status, transaction_number")
    .eq("id", receipt.expense_id)
    .maybeSingle();

  if (error || !data) {
    mismatches.push("expense could not be read back");
    return mismatches;
  }
  if (data.status !== expected.status) {
    mismatches.push(`status is ${data.status}, expected ${expected.status}`);
  }
  if (expected.transactionNumberPresent && !data.transaction_number) {
    mismatches.push("transaction number missing after commit");
  }
  if (
    receipt.transaction_number &&
    data.transaction_number &&
    receipt.transaction_number !== data.transaction_number
  ) {
    mismatches.push("transaction number differs from the receipt");
  }
  return mismatches;
}
