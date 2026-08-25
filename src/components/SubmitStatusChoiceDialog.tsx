/**
 * Status-choice popup shown when an admin submits an expense on behalf of an
 * employee (single or bulk) — lets them pick the RESULTING status instead of
 * always landing on "submitted". Reuses existing, already-audited RPCs
 * (ExpenseService.adminVerifyExpense / approveExpense — see
 * applyAdminSubmitStatusChoice in src/lib/adminSubmitExpense.ts) for the
 * actual transition; this component is presentation + the confirm gate only.
 *
 * A comment is REQUIRED specifically for "Approved" (not Verified/Submitted)
 * — a cheap, zero-schema-change segregation-of-duties mitigation: the same
 * admin who creates the expense and chooses to approve it leaves a written
 * reason, which lands in the real audit_logs row (see
 * buildStatusTransitionComment's self-approval marker).
 */
import { useState } from "react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle } from "lucide-react";
import type { AdminSubmitStatusChoice } from "@/lib/adminSubmitExpense";

interface SubmitStatusChoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "this expense" or "these 12 expenses" — used in the description copy. */
  subjectLabel: string;
  onConfirm: (status: AdminSubmitStatusChoice, comment: string) => void;
  confirming?: boolean;
}

export function SubmitStatusChoiceDialog({
  open, onOpenChange, subjectLabel, onConfirm, confirming = false,
}: SubmitStatusChoiceDialogProps) {
  const [status, setStatus] = useState<AdminSubmitStatusChoice>("submitted");
  const [comment, setComment] = useState("");

  const reset = () => { setStatus("submitted"); setComment(""); };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const approvedCommentMissing = status === "approved" && comment.trim() === "";

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>How should {subjectLabel} be saved?</AlertDialogTitle>
          <AlertDialogDescription>
            Choose the status {subjectLabel} should land on. This applies to all of them if it's a batch.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <RadioGroup value={status} onValueChange={(v) => setStatus(v as AdminSubmitStatusChoice)} className="space-y-3">
          <div className="flex items-start gap-3">
            <RadioGroupItem value="submitted" id="status-submitted" className="mt-1" />
            <Label htmlFor="status-submitted" className="font-normal cursor-pointer">
              <span className="font-medium">Submitted</span> — the normal flow. Goes through the usual review pipeline.
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem value="verified" id="status-verified" className="mt-1" />
            <Label htmlFor="status-verified" className="font-normal cursor-pointer">
              <span className="font-medium">Verified</span> — skips straight to verified, bypassing the reviewer hierarchy. No money moves.
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem value="approved" id="status-approved" className="mt-1" />
            <Label htmlFor="status-approved" className="font-normal cursor-pointer">
              <span className="font-medium">Approved</span> — skips straight to approved, with no independent review by anyone else.
            </Label>
          </div>
        </RadioGroup>

        {status === "approved" && (
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>This immediately deducts the amount from the employee's balance. There is no independent review — please explain why below.</span>
          </div>
        )}

        {status !== "submitted" && (
          <div className="space-y-1.5">
            <Label htmlFor="status-comment">
              Reason / comment {status === "approved" ? "(required)" : "(optional)"}
            </Label>
            <Textarea
              id="status-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={status === "approved" ? "Why is this being approved immediately?" : "Optional note"}
              rows={3}
            />
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={confirming}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={confirming || approvedCommentMissing}
            onClick={(e) => {
              e.preventDefault();
              onConfirm(status, comment.trim());
            }}
          >
            {confirming ? "Submitting…" : "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
