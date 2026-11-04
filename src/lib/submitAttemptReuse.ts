/**
 * One logical Submit = one expense row (DOC-148).
 *
 * Identity lives in the DATABASE: every Submit carries a client_submission_id and the server's
 * resolve_or_create_expense_v1 maps (organization, user, id) to exactly one row, guarded by a
 * unique index. The browser does not need to remember the row id, so clearing sessionStorage,
 * reloading or restarting the browser cannot create a second row. These pure helpers only decide
 * what the form does with the server's answer.
 */

export type ResolvedExpenseState = {
  status: string;
  inRecycleBin?: boolean;
};

export type ResolveDecision =
  /** Row is a live draft (new or reused): continue saving fields/receipts and submit it. */
  | "proceed"
  /** An earlier press already committed it: do not touch, log or notify again. */
  | "already_past_draft"
  /** The logical expense was trashed: the user must restore it or start a new one. */
  | "recycled";

export function decideAfterResolve(r: ResolvedExpenseState): ResolveDecision {
  if (r.inRecycleBin) return "recycled";
  if (r.status === "draft") return "proceed";
  // 'rejected' is a legitimate resubmission target for a row that came back to the owner.
  if (r.status === "rejected") return "proceed";
  return "already_past_draft";
}

/** Only a row that is still a draft (or a rejected one being resubmitted) may be submitted. */
export function shouldRunSubmit(status: string | null | undefined): boolean {
  return status === "draft" || status === "rejected";
}

/** Success may only be reported once the row is really past 'draft'. */
export function isSubmittedStatus(status: string | null | undefined): boolean {
  return !!status && status !== "draft";
}

/** A fresh, random logical-submission id. Isolated so tests can stub it. */
export function newClientSubmissionId(): string {
  return crypto.randomUUID();
}
