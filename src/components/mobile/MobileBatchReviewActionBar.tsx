import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BatchReviewAction } from "@/lib/batchExpenseReview";

interface MobileBatchReviewActionBarProps {
  actionLoading: BatchReviewAction | null;
  canVerify: boolean;
  canApprove: boolean;
  canReject: boolean;
  canCorrect: boolean;
  correctionOpen: boolean;
  onVerify: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCorrect: () => void;
}

export function MobileBatchReviewActionBar({
  actionLoading,
  canVerify,
  canApprove,
  canReject,
  canCorrect,
  correctionOpen,
  onVerify,
  onApprove,
  onReject,
  onCorrect,
}: MobileBatchReviewActionBarProps) {
  if (actionLoading) {
    return (
      <div className="mobile-batch-action-bar justify-center">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        <span className="text-sm text-muted-foreground">Processing…</span>
      </div>
    );
  }

  return (
    <div className="mobile-batch-action-bar">
      {canCorrect && !correctionOpen && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-[44px] flex-1"
          onClick={onCorrect}
        >
          Correct
        </Button>
      )}
      <Button
        type="button"
        variant="destructive"
        size="sm"
        className="min-h-[44px] flex-1"
        disabled={!canReject}
        onClick={onReject}
      >
        Reject
      </Button>
      {canApprove ? (
        <Button
          type="button"
          size="sm"
          className="min-h-[44px] flex-1"
          onClick={onApprove}
        >
          Approve
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-[44px] flex-1"
          disabled={!canVerify}
          onClick={onVerify}
        >
          Verify
        </Button>
      )}
    </div>
  );
}
