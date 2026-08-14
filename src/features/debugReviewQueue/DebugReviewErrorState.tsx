/**
 * Distinct error surfaces (DOC-080 Phase 21).
 *
 * Every state maps to a stable i18n key. A raw Postgres message never reaches an
 * ordinary reviewer. Nothing here falls back to /review or to the V1/V2 fetchers
 * — the link back is an explicit user choice, not an automatic redirect.
 */

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DEBUG_ERROR_MESSAGE_KEY, type DebugErrorKind } from "./errorKind";

export function DebugReviewErrorState({
  kind,
  missingFunctions,
  onRetry,
  showReviewLink = true,
}: {
  kind: DebugErrorKind;
  missingFunctions?: string[];
  onRetry?: () => void;
  showReviewLink?: boolean;
}) {
  const { t } = useTranslation("debugReview");

  return (
    <Alert variant="destructive" data-testid={`debug-error-${kind}`}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{t("errors.title")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t(DEBUG_ERROR_MESSAGE_KEY[kind])}</p>

        {kind === "flag_disabled" && (
          <p className="text-xs opacity-80">{t("errors.flagDisabledHint")}</p>
        )}

        {/* Naming the missing functions is the whole point of a partial-migration
            state — "not ready" alone tells an operator nothing actionable. */}
        {kind === "capability" && missingFunctions && missingFunctions.length > 0 && (
          <p className="text-xs font-mono" data-testid="debug-missing-functions">
            {t("errors.capabilityMissing", { functions: missingFunctions.join(", ") })}
          </p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("errors.retry")}
            </Button>
          )}
          {showReviewLink && (
            <Button size="sm" variant="ghost" asChild>
              <Link to="/review">{t("backToReview")}</Link>
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
