import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, ShieldCheck, Edit3, Loader2 } from "lucide-react";
import type { Expense } from "@/pages/EngineerReview";

type Props = {
  expense: Expense | null;
  canApprove: boolean;
  canCorrect: boolean;
  isActionDisabled: boolean;
  reviewLoading: boolean;
  correctionOpen: boolean;
  onVerify: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCorrect: () => void;
};

export function MobileReviewActionBar({
  canApprove,
  canCorrect,
  isActionDisabled,
  reviewLoading,
  correctionOpen,
  onVerify,
  onApprove,
  onReject,
  onCorrect,
}: Props) {
  if (reviewLoading) {
    return (
      <div className="mobile-review-action-bar">
        <div className="flex items-center justify-center w-full py-1 text-sm text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Processing…
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-review-action-bar">
      {canCorrect && !correctionOpen && (
        <Button
          variant="outline"
          size="sm"
          onClick={onCorrect}
          disabled={isActionDisabled}
          className="min-h-[44px] flex-1 text-xs"
        >
          <Edit3 className="h-3.5 w-3.5 mr-1" />
          Correct
        </Button>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={onReject}
        disabled={isActionDisabled}
        className="min-h-[44px] flex-1 text-xs border-red-200 text-red-700 hover:bg-red-50"
      >
        <XCircle className="h-3.5 w-3.5 mr-1" />
        Reject
      </Button>

      {canApprove ? (
        <Button
          size="sm"
          onClick={onApprove}
          disabled={isActionDisabled}
          className="min-h-[44px] flex-1 text-xs bg-green-600 hover:bg-green-700"
        >
          <CheckCircle className="h-3.5 w-3.5 mr-1" />
          Approve
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={onVerify}
          disabled={isActionDisabled}
          className="min-h-[44px] flex-1 text-xs"
        >
          <ShieldCheck className="h-3.5 w-3.5 mr-1" />
          Verify
        </Button>
      )}
    </div>
  );
}
