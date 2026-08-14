import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { blurFocusedNumberInputOnWheel } from "@/lib/numberInputWheel";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BatchExpenseDetailCard } from "@/components/BatchExpenseDetailCard";
import { MobileBatchReviewActionBar } from "@/components/mobile/MobileBatchReviewActionBar";
import { ExpenseCategorySelect } from "@/components/ExpenseCategorySelect";
import type { BatchReviewExpenseRow, BatchReviewAction, BatchReviewRole } from "@/lib/batchExpenseReview";

interface MobileBatchLineDetailProps {
  expense: BatchReviewExpenseRow;
  organizationId: string;
  role: BatchReviewRole;
  actionLoading: BatchReviewAction | null;
  canVerify: boolean;
  canApprove: boolean;
  canReject: boolean;
  correctionDialogOpen: boolean;
  correctionLoading: boolean;
  corrTitle: string;
  setCorrTitle: (v: string) => void;
  corrDestination: string;
  setCorrDestination: (v: string) => void;
  corrExpenseDate: string;
  setCorrExpenseDate: (v: string) => void;
  corrPurpose: string;
  setCorrPurpose: (v: string) => void;
  corrCategory: string;
  setCorrCategory: (v: string) => void;
  corrAmount: string;
  setCorrAmount: (v: string) => void;
  corrReason: string;
  setCorrReason: (v: string) => void;
  reviewComment: string;
  setReviewComment: (v: string) => void;
  titleLabel?: string;
  destinationLabel?: string;
  purposeLabel?: string;
  categoryLabel?: string;
  amountLabel?: string;
  onBack: () => void;
  onVerify: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCorrect: () => void;
  onSubmitCorrection: () => void;
  onCancelCorrection: () => void;
}

export function MobileBatchLineDetail({
  expense,
  organizationId,
  role,
  actionLoading,
  canVerify,
  canApprove,
  canReject,
  correctionDialogOpen,
  correctionLoading,
  corrTitle,
  setCorrTitle,
  corrDestination,
  setCorrDestination,
  corrExpenseDate,
  setCorrExpenseDate,
  corrPurpose,
  setCorrPurpose,
  corrCategory,
  setCorrCategory,
  corrAmount,
  setCorrAmount,
  corrReason,
  setCorrReason,
  reviewComment,
  setReviewComment,
  titleLabel,
  destinationLabel,
  purposeLabel,
  categoryLabel,
  amountLabel,
  onBack,
  onVerify,
  onApprove,
  onReject,
  onCorrect,
  onSubmitCorrection,
  onCancelCorrection,
}: MobileBatchLineDetailProps) {
  const canCorrect = role !== "employee";

  return (
    <div className="space-y-3 pb-4">
      <div className="flex items-center gap-2 px-1 pt-1">
        <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <p className="text-sm font-medium truncate flex-1">{expense.title}</p>
      </div>

      <BatchExpenseDetailCard
        expense={expense}
        organizationId={organizationId}
        categoryLabel={categoryLabel}
        purposeLabel={purposeLabel}
        amountLabel={amountLabel}
        destinationLabel={destinationLabel}
        onClose={onBack}
      />

      {canCorrect && (
        <div className="space-y-1 px-1">
          <Label htmlFor="mb-batch-review-comment" className="text-sm">
            Review comment (optional)
          </Label>
          <Textarea
            id="mb-batch-review-comment"
            placeholder="Add a comment for this action…"
            value={reviewComment}
            onChange={(e) => setReviewComment(e.target.value)}
            rows={2}
            style={{ fontSize: "16px" }}
          />
        </div>
      )}

      {correctionDialogOpen && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-3 mx-1">
          <p className="text-sm font-semibold text-amber-900">Correct this expense</p>
          <div>
            <Label htmlFor="mb-corr-title">{titleLabel ?? "Title"}</Label>
            <Input
              id="mb-corr-title"
              value={corrTitle}
              onChange={(e) => setCorrTitle(e.target.value)}
              style={{ fontSize: "16px" }}
            />
          </div>
          <div>
            <Label htmlFor="mb-corr-dest">{destinationLabel ?? "Destination"}</Label>
            <Input
              id="mb-corr-dest"
              value={corrDestination}
              onChange={(e) => setCorrDestination(e.target.value)}
              style={{ fontSize: "16px" }}
            />
          </div>
          <div>
            <Label htmlFor="mb-corr-date">Date of expense</Label>
            <Input
              id="mb-corr-date"
              type="date"
              value={corrExpenseDate}
              onChange={(e) => setCorrExpenseDate(e.target.value)}
              style={{ fontSize: "16px" }}
            />
          </div>
          <div>
            <Label htmlFor="mb-corr-purpose">{purposeLabel ?? "Purpose"}</Label>
            <Textarea
              id="mb-corr-purpose"
              rows={2}
              value={corrPurpose}
              onChange={(e) => setCorrPurpose(e.target.value)}
              style={{ fontSize: "16px" }}
            />
          </div>
          <div>
            <Label htmlFor="mb-corr-cat">{categoryLabel ?? "Category"}</Label>
            <ExpenseCategorySelect
              id="mb-corr-cat"
              organizationId={organizationId}
              value={corrCategory}
              onChange={setCorrCategory}
            />
          </div>
          <div>
            <Label htmlFor="mb-corr-amt">{amountLabel ?? "Amount"}</Label>
            <Input
              id="mb-corr-amt"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              onWheelCapture={blurFocusedNumberInputOnWheel}
              value={corrAmount}
              onChange={(e) => setCorrAmount(e.target.value)}
              style={{ fontSize: "16px" }}
            />
          </div>
          <div>
            <Label htmlFor="mb-corr-reason">Reason for correction (audit)</Label>
            <Textarea
              id="mb-corr-reason"
              rows={2}
              value={corrReason}
              onChange={(e) => setCorrReason(e.target.value)}
              style={{ fontSize: "16px" }}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 min-h-[44px]"
              onClick={onCancelCorrection}
              disabled={correctionLoading}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 min-h-[44px]"
              onClick={onSubmitCorrection}
              disabled={correctionLoading}
            >
              {correctionLoading ? "Saving…" : "Save correction"}
            </Button>
          </div>
        </div>
      )}

      <MobileBatchReviewActionBar
        actionLoading={actionLoading}
        canVerify={canVerify}
        canApprove={canApprove}
        canReject={canReject}
        canCorrect={canCorrect}
        correctionOpen={correctionDialogOpen}
        onVerify={onVerify}
        onApprove={onApprove}
        onReject={onReject}
        onCorrect={onCorrect}
      />
    </div>
  );
}
