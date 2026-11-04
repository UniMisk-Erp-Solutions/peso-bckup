/**
 * MicroLink "attach first, then submit" orchestration (new expense that needs a
 * bill): save draft -> attach the files -> (caller) submit.
 *
 * Extracted from ExpenseForm so the failure/retry matrix can be tested without
 * rendering the form. Behaviour is unchanged from the inline code it replaced.
 *
 * Rules enforced here:
 *  - the draft step has its OWN idempotency key (never the submit key), so a
 *    retry replays the same draft and never creates a second expense;
 *  - any draft/attach failure aborts BEFORE the submit and leaves nothing
 *    submitted -- the caller keeps the keys so the next click resumes the same
 *    draft and the same attachments (the finalize step is idempotent by
 *    destination path);
 *  - the submit snapshot carries the draft's expense_id and revision.
 */
import {
  saveMicroLinkExpenseDraft,
  snapshotWithIdempotencyKey,
  type SubmissionOutcome,
} from "@/services/microlinkExpensePersistence";
import type { MicroLinkExpenseSnapshotV1 } from "@/lib/microlinkExpenseSnapshot";

export interface AttachFirstDeps {
  /** Move/finalize the uploaded files onto the draft expense. Throws on failure. */
  attachFiles: (expenseId: string) => Promise<void>;
  /** Called for every way this step can fail (monitoring). */
  onFailure: (
    stage: "draft_save" | "attach_receipts",
    error: unknown,
    info: { errorCode?: string; severity: "warning" | "error" },
  ) => void;
  /** Progress callback after the draft is saved, before files are attached. */
  onDraftSaved?: () => void;
  saveDraft?: (snapshot: MicroLinkExpenseSnapshotV1) => Promise<SubmissionOutcome>;
}

export async function prepareAttachFirstSubmit(
  snapshot: MicroLinkExpenseSnapshotV1,
  draftKey: string,
  deps: AttachFirstDeps,
): Promise<MicroLinkExpenseSnapshotV1> {
  const save = deps.saveDraft ?? saveMicroLinkExpenseDraft;
  const draft = await save(snapshotWithIdempotencyKey(snapshot, draftKey));
  if (draft.kind !== "committed") {
    deps.onFailure("draft_save", new Error(`microlink draft step ${draft.kind}`), {
      errorCode: draft.kind === "rejected" ? draft.code : undefined,
      severity: draft.kind === "rejected" ? "warning" : "error",
    });
    throw new Error(
      draft.kind === "rejected"
        ? draft.message
        : "Your expense could not be saved. Nothing was submitted.",
    );
  }
  deps.onDraftSaved?.();
  try {
    await deps.attachFiles(draft.receipt.expense_id);
  } catch (attachError) {
    // The draft exists but the files did not attach: nothing is submitted.
    deps.onFailure("attach_receipts", attachError, { severity: "error" });
    throw attachError;
  }
  return {
    ...snapshot,
    expense_id: draft.receipt.expense_id,
    expected_revision: draft.receipt.revision,
  };
}
