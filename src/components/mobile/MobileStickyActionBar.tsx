import { Button } from "@/components/ui/button";
import { Loader2, Send } from "lucide-react";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import type { OperationStatus } from "@/hooks/useOperationProgress";

type Props = {
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  disabled: boolean;
  loading: boolean;
  /** Current operation stage label shown above the button while loading */
  progressTitle?: string;
  /** Short description under the stage label */
  progressDescription?: string;
  progressStatus?: OperationStatus;
};

export function MobileStickyActionBar({
  onSubmit,
  onCancel,
  submitLabel,
  disabled,
  loading,
  progressTitle,
  progressDescription,
  progressStatus = "idle",
}: Props) {
  const showProgress = loading && progressStatus !== "idle" && progressTitle;

  return (
    <div className="mobile-sticky-action-bar">
      {showProgress && (
        <div className="px-4 pt-2 pb-1">
          <AsyncOperationProgress
            status={progressStatus}
            title={progressTitle}
            description={progressDescription}
            compact
          />
        </div>
      )}
      <div className="flex gap-2 px-4 pb-4">
        <Button
          onClick={onSubmit}
          disabled={disabled}
          className="flex-1 min-h-[44px]"
        >
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-2 h-4 w-4" />
          )}
          {loading && progressTitle ? progressTitle : submitLabel}
        </Button>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={loading}
          className="flex-1 min-h-[44px]"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
