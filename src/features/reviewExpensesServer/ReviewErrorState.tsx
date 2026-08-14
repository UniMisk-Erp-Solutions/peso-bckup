/**
 * Production error surfaces (DOC-080 §18).
 *
 * Production wording only — no contract names, no schema revisions, no SQL, no
 * debug vocabulary. Retry re-runs the failed request only; it never restarts a
 * full queue load, and it never silently swaps back to EngineerReview.
 */

import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { REVIEW_EXPENSES_LEGACY_ESCAPE_HATCH } from "@/config/reviewQueueServerFeature";
import { REVIEW_ERROR_MESSAGE_KEY, type ReviewErrorKind } from "./errorKind";

export function ReviewErrorState({
  kind,
  onRetry,
  onUseLegacy,
}: {
  kind: ReviewErrorKind;
  onRetry?: () => void;
  onUseLegacy?: () => void;
}) {
  const { t } = useTranslation("admin");

  return (
    <Alert variant="destructive" data-testid={`review-error-${kind}`}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t("review.errors.title")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t(REVIEW_ERROR_MESSAGE_KEY[kind])}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry} data-testid="review-error-retry">
              {t("review.errors.retry")}
            </Button>
          )}
          {/* Dev/Preview only, and only ever on an explicit click. */}
          {REVIEW_EXPENSES_LEGACY_ESCAPE_HATCH && onUseLegacy && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onUseLegacy}
              data-testid="review-use-legacy"
            >
              {t("review.errors.useLegacy")}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
