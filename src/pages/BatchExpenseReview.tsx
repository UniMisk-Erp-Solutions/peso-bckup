import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { BatchExpenseReviewPanel } from "@/components/BatchExpenseReviewPanel";
import type { BatchReviewRole } from "@/lib/batchExpenseReview";
import { useViewportMode } from "@/hooks/useViewportMode";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import {
  readSnapshotFromLocationState,
  REVIEW_RETURN_STATE_KEY,
} from "@/features/reviewExpensesServer/reviewQueueReturnState";

export default function BatchExpenseReview() {
  const { t } = useTranslation(["expenses", "common"]);
  const { batchId } = useParams<{ batchId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, userRole, organizationId } = useAuth();
  const { isMobile } = useViewportMode();
  const [engineerApprovalLimit, setEngineerApprovalLimit] = useState(50000);

  const from = searchParams.get("from");
  const highlightExpenseId = searchParams.get("expense");

  const role: BatchReviewRole | null =
    userRole === "admin"
      ? "admin"
      : userRole === "engineer"
        ? "engineer"
        : userRole === "team_leader"
          ? "team_leader"
          : userRole === "executive"
            ? "executive"
            : userRole === "employee"
              ? "employee"
              : null;

  useEffect(() => {
    if (!organizationId || role !== "engineer") return;
    (async () => {
      const { data } = await supabase
        .from("organization_settings")
        .select("engineer_approval_limit")
        .eq("organization_id", organizationId)
        .maybeSingle();
      const rawLimit = data?.engineer_approval_limit;
      if (rawLimit === null || rawLimit === undefined || Number(rawLimit) <= 0) {
        setEngineerApprovalLimit(Number.POSITIVE_INFINITY);
        return;
      }
      const limit = Number(rawLimit);
      setEngineerApprovalLimit(Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY);
    })();
  }, [organizationId, role]);

  const backPath =
    from === "admin" ? "/admin/expenses" : from === "review" ? "/review" : "/admin/expenses";

  /**
   * The Review Expenses working context, if this page was opened from there.
   *
   * Revalidated here rather than trusted: `location.state` is attacker-influencable in
   * principle and reviewer-mismatched in practice (a sign-out and sign-in inside one tab
   * leaves the old entry in history). Anything that fails validation simply becomes a
   * plain back-navigation.
   */
  const returnSnapshot = readSnapshotFromLocationState(location.state, {
    organizationId,
    reviewerUserId: user?.id ?? null,
  });

  /**
   * ONE handler behind every Back control, desktop and mobile alike.
   *
   * `replace: true` matters: without it, returning pushes a second /review entry on top
   * of the batch, so the browser Back button reopens the batch the reviewer just left —
   * a loop they cannot escape without holding Back.
   */
  const handleBack = useCallback(() => {
    // Canonical Review return: EngineerReview owns restoration via its workspace
    // snapshot + return cache (the return-intent marker was set on the way in), so
    // Back always REPLACES the batch history entry — with or without a legacy
    // location.state snapshot. `replace: true` is what stops browser Back from
    // reopening the batch the reviewer just left (§16/§17/§30).
    if (from === "review") {
      navigate("/review", {
        replace: true,
        ...(returnSnapshot ? { state: { [REVIEW_RETURN_STATE_KEY]: returnSnapshot } } : {}),
      });
      return;
    }
    navigate(backPath);
  }, [navigate, from, returnSnapshot, backPath]);

  if (!batchId || !user?.id || !organizationId || !role) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p>{t("expenses:batch.unableToOpen")}</p>
        <Button variant="link" onClick={handleBack}>
          {t("common:goBack")}
        </Button>
      </div>
    );
  }

  return (
    <div className={isMobile ? "pb-4" : "space-y-6 max-w-6xl mx-auto p-4 sm:p-6"}>
      {isMobile ? (
        /**
         * Mobile previously had NO Back control at all — the header was desktop-only, so
         * a phone reviewer's only way out was the browser gesture, which took the
         * `location.state` path with it and lost the working context. Restoration must not
         * differ by viewport, so mobile gets the same handler behind a compact header.
         */
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-3 py-2">
          <Button variant="ghost" size="sm" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t("common:back")}
          </Button>
          <h1 className="truncate text-base font-semibold">{t("expenses:batch.review")}</h1>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t("common:back")}
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">{t("expenses:batch.review")}</h1>
        </div>
      )}

      <BatchExpenseReviewPanel
        batchId={batchId}
        organizationId={organizationId}
        userId={user.id}
        role={role}
        engineerApprovalLimit={engineerApprovalLimit}
        highlightExpenseId={highlightExpenseId}
        onReviewComplete={() => {
          // stay on page; panel reloads batch data
        }}
      />
    </div>
  );
}
