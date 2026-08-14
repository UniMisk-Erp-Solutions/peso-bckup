/**
 * Bulk action toolbar (DOC-080 §17).
 *
 * Same blue toolbar as the existing page. Eligibility comes entirely from the
 * server response — `available_actions` and `view_only`, plus "no batch_id" —
 * never from "status is not terminal", which would offer actions on rows sitting
 * at another reviewer's tier.
 *
 * Hidden entirely while the actions flag is off, so no mutation control exists
 * to click.
 */

import { useTranslation } from "react-i18next";
import { CheckCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReviewBulkActions({
  selectedCount,
  canVerify,
  canApprove,
  canReject,
  busy,
  onVerify,
  onApprove,
  onReject,
  onClear,
}: {
  selectedCount: number;
  canVerify: boolean;
  canApprove: boolean;
  canReject: boolean;
  busy: boolean;
  onVerify: () => void;
  onApprove: () => void;
  onReject: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation("admin");
  if (selectedCount === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-4 py-2 mb-3"
      data-testid="review-bulk-actions"
    >
      <span className="text-sm font-medium text-blue-700 dark:text-blue-300 flex-1">
        {t("review.selectedCount", { count: selectedCount })}
      </span>
      {canVerify && (
        <Button
          size="sm"
          variant="outline"
          className="text-green-700 border-green-300"
          onClick={onVerify}
          disabled={busy}
          data-testid="review-bulk-verify"
        >
          <CheckCircle className="w-4 h-4 mr-1" /> Verify
        </Button>
      )}
      {canApprove && (
        <Button
          size="sm"
          variant="outline"
          className="text-green-700 border-green-300"
          onClick={onApprove}
          disabled={busy}
          data-testid="review-bulk-approve"
        >
          <CheckCircle className="w-4 h-4 mr-1" /> Approve
        </Button>
      )}
      {canReject && (
        <Button
          size="sm"
          variant="outline"
          className="text-red-700 border-red-300"
          onClick={onReject}
          disabled={busy}
          data-testid="review-bulk-reject"
        >
          <XCircle className="w-4 h-4 mr-1" /> Reject
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
        Clear
      </Button>
    </div>
  );
}
