import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import type { AdminSubmitStatusChoice } from "@/lib/adminSubmitExpense";

type SubmitStatusChoiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (status: AdminSubmitStatusChoice, comment: string) => void;
  submitting?: boolean;
};

/**
 * Lets the admin choose the expense's initial status. "Approved" means the
 * SAME admin both created and approved the expense in one action — a real
 * segregation-of-duties scenario, not an ordinary approval, so it requires an
 * explicit typed reason and a visible warning rather than being one more
 * radio option with no friction.
 */
export function SubmitStatusChoiceDialog({
  open,
  onOpenChange,
  onConfirm,
  submitting,
}: SubmitStatusChoiceDialogProps) {
  const [status, setStatus] = useState<AdminSubmitStatusChoice>("submitted");
  const [comment, setComment] = useState("");

  const approvedCommentMissing = status === "approved" && comment.trim() === "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose submission status</DialogTitle>
          <DialogDescription>
            The expense will be created for the selected employee with this status.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup value={status} onValueChange={(v) => setStatus(v as AdminSubmitStatusChoice)} className="space-y-3">
          <div className="flex items-start gap-2">
            <RadioGroupItem value="submitted" id="status-submitted" className="mt-1" />
            <Label htmlFor="status-submitted" className="font-normal">
              <span className="font-medium">Submitted</span> — goes through the usual review pipeline.
              The employee's own reviewer/hierarchy is assigned normally.
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="verified" id="status-verified" className="mt-1" />
            <Label htmlFor="status-verified" className="font-normal">
              <span className="font-medium">Verified</span> — skips straight to verified. No money moves.
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="approved" id="status-approved" className="mt-1" />
            <Label htmlFor="status-approved" className="font-normal">
              <span className="font-medium">Approved</span> — skips straight to approved, with no
              independent review by anyone else. The employee's balance is deducted immediately.
            </Label>
          </div>
        </RadioGroup>

        {status === "approved" && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <p>
              This immediately deducts the amount from the employee&apos;s balance. There is no
              independent review — please explain why below.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="status-comment">
            {status === "approved" ? "Reason (required)" : "Comment (optional)"}
          </Label>
          <Textarea
            id="status-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              status === "approved"
                ? "Why is this being approved directly, without independent review?"
                : "Optional note for the audit trail"
            }
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(status, comment.trim())}
            disabled={approvedCommentMissing || submitting}
          >
            {submitting ? "Submitting…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
