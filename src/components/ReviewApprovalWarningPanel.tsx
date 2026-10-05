import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import type { ApprovalClassification } from "@/lib/reviewBulkSelection";

export type ReviewApprovalWarningLabels = {
  readyNow: string;
  waiting: string;
  viewWaiting: (count: number) => string;
  hideWaiting: string;
  overLimit: string;
  completed: string;
  selectedTotal: string;
  overrideUnavailable: string;
  stop: string;
  managerOverride: (count: number) => string;
  approveReadyNow: (count: number) => string;
};

type Props = {
  classification: ApprovalClassification;
  formattedTotal: string;
  overrideEffective: boolean;
  loading: boolean;
  waitingExpanded: boolean;
  waitingDetails?: ReactNode;
  labels: ReviewApprovalWarningLabels;
  onToggleWaiting: () => void;
  onStop: () => void;
  onOverride: () => void;
  onApproveReady: () => void;
};

/** The real Bulk Approve dialog body/actions, isolated for payload-to-UI tests. */
export function ReviewApprovalWarningPanel({
  classification,
  formattedTotal,
  overrideEffective,
  loading,
  waitingExpanded,
  waitingDetails,
  labels,
  onToggleWaiting,
  onStop,
  onOverride,
  onApproveReady,
}: Props) {
  return (
    <>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span>{labels.readyNow}</span>
          <span className="font-medium text-green-700" data-testid="approval-warning-ready">
            {classification.readyNow.length}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>{labels.waiting}</span>
          <span className="flex items-center gap-2">
            <span className="font-medium text-amber-700" data-testid="approval-warning-waiting">
              {classification.waiting.length}
            </span>
            {classification.waiting.length > 0 && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={onToggleWaiting}
                data-testid="approval-warning-view-waiting"
              >
                {waitingExpanded
                  ? labels.hideWaiting
                  : labels.viewWaiting(classification.waiting.length)}
              </Button>
            )}
          </span>
        </div>
        {waitingExpanded && waitingDetails}
        <div className="flex justify-between">
          <span>{labels.overLimit}</span>
          <span className="font-medium text-red-700" data-testid="approval-warning-overlimit">
            {classification.overLimit.length}
          </span>
        </div>
        <div className="flex justify-between">
          <span>{labels.completed}</span>
          <span className="font-medium text-muted-foreground" data-testid="approval-warning-completed">
            {classification.terminal.length}
          </span>
        </div>
        <div className="mt-2 flex justify-between border-t pt-2">
          <span>{labels.selectedTotal}</span>
          <span className="font-semibold">{formattedTotal}</span>
        </div>
        {classification.waiting.length > 0 && !overrideEffective && (
          <p
            className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
            data-testid="approval-warning-override-note"
          >
            {labels.overrideUnavailable}
          </p>
        )}
      </div>
      <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
        <Button
          variant="outline"
          onClick={onStop}
          disabled={loading}
          data-testid="approval-warning-stop"
        >
          {labels.stop}
        </Button>
        <div className="flex flex-col gap-2 sm:flex-row">
          {overrideEffective && classification.waiting.length > 0 && (
            <Button
              type="button"
              variant="outline"
              className="border-amber-400 text-amber-800 hover:bg-amber-50"
              onClick={onOverride}
              disabled={loading}
              data-testid="approval-warning-override-open"
            >
              {labels.managerOverride(classification.waiting.length)}
            </Button>
          )}
          <Button
            onClick={onApproveReady}
            disabled={classification.readyNow.length === 0 || loading}
            data-testid="approval-warning-proceed"
          >
            {labels.approveReadyNow(classification.readyNow.length)}
          </Button>
        </div>
      </AlertDialogFooter>
    </>
  );
}
