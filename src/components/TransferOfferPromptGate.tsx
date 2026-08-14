import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Coins, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import {
  BalanceTransferOfferService,
  type BalanceTransferOffer,
} from "@/services/BalanceTransferOfferService";
import { validateTransferRejectionReason } from "@/lib/balanceTransferOfferValidation";
import { formatINR } from "@/lib/format";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// ─────────────────────────────────────────────────────────────────────────────

/** Show a rejection-reason text box and call onConfirm when valid. */
function RejectReasonStep({
  offer,
  loading,
  onCancel,
  onConfirm,
}: {
  offer: BalanceTransferOffer;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation("transfers");
  const [reason, setReason] = useState("");
  const { toast } = useToast();

  const handleConfirm = () => {
    const validation = validateTransferRejectionReason(reason);
    if (!validation.valid) {
      toast({
        variant: "destructive",
        title: t("validation.rejectionReasonTooShort"),
      });
      return;
    }
    onConfirm(reason.trim());
  };

  return (
    <div className="space-y-4 py-2">
      <p className="text-sm text-muted-foreground">
        {t("rejectDescription", {
          defaultValue: "Please provide a reason for rejecting this transfer.",
        })}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="popup-reject-reason">
          {t("rejectReasonLabel", { defaultValue: "Rejection reason" })}
        </Label>
        <Textarea
          id="popup-reject-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("rejectReasonPlaceholder", {
            defaultValue: "e.g. Wrong amount, incorrect project…",
          })}
          rows={3}
          autoFocus
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} disabled={loading}>
          {t("common:cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button
          variant="destructive"
          onClick={handleConfirm}
          disabled={loading || reason.trim().length < 3}
        >
          {loading
            ? t("common:saving", { defaultValue: "Saving…" })
            : t("rejectConfirm", { defaultValue: "Confirm rejection" })}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * TransferOfferPromptGate
 *
 * Mounts in Layout (both mobile and desktop paths). When
 * `transfer_recipient_acceptance` is enabled and the logged-in user has at
 * least one pending transfer offer, shows a blocking modal so they can
 * accept or reject it immediately.
 *
 * Multiple pending offers are queued one by one — after responding to one
 * the next surfaces automatically.
 *
 * The gate also subscribes to Supabase realtime on
 * `public.balance_transfer_offers` for INSERT/UPDATE so new offers that
 * arrive while the user is already in the app are surfaced without a reload.
 *
 * Does NOT render for:
 *  - feature flag disabled
 *  - unauthenticated users
 *  - master_admin role
 *  - accountant-cashier mode
 */
export function TransferOfferPromptGate() {
  const { t } = useTranslation("transfers");
  const { user, userRole, isAccountantCashier, hasOrganizationFeature, refreshBalance } =
    useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const featureEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance,
  );

  // Whether the popup should be active for this user at all.
  const shouldRun =
    featureEnabled &&
    !!user?.id &&
    userRole !== "master_admin" &&
    !isAccountantCashier;

  const [queue, setQueue] = useState<BalanceTransferOffer[]>([]);
  const [loading, setLoading] = useState(false);
  const [rejectStep, setRejectStep] = useState(false);
  const {
    progress: actionProgress,
    startOperation: startActionProgress,
    completeOperation: completeActionProgress,
  } = useOperationProgress();
  const prevActionLoadingRef = useRef(false);

  useEffect(() => {
    const wasLoading = prevActionLoadingRef.current;
    prevActionLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startActionProgress(t("common:saving", { defaultValue: "Processing…" }));
    } else if (!loading && wasLoading) {
      completeActionProgress(t("promptGate.done", { defaultValue: "Done" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Prevent double-fetching in strict-mode double-invoke.
  const fetchingRef = useRef(false);
  // Track which offer IDs we've already queued to avoid duplicates on realtime.
  const seenIdsRef = useRef<Set<string>>(new Set());

  const currentOffer = queue[0] ?? null;

  // ── Fetch pending offers ──────────────────────────────────────────────────

  const fetchPending = useCallback(async () => {
    if (!user?.id || !shouldRun) return;
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const offers = await BalanceTransferOfferService.fetchPendingForRecipient(user.id);
      setQueue((prev) => {
        // Keep any offers still in prev that are still pending (preserve order
        // so the user sees the same offer they started looking at), then append
        // newly discovered ones.
        const prevIds = new Set(prev.map((o) => o.id));
        const pendingIds = new Set(offers.map((o) => o.id));

        // Remove from queue any offers no longer pending in DB.
        const stillPending = prev.filter((o) => pendingIds.has(o.id));

        // Append new ones not yet in queue.
        const fresh = offers.filter((o) => !prevIds.has(o.id));
        fresh.forEach((o) => seenIdsRef.current.add(o.id));

        return [...stillPending, ...fresh];
      });
      // Mark all fetched as seen.
      offers.forEach((o) => seenIdsRef.current.add(o.id));
    } catch (err) {
      console.warn("[TransferOfferPromptGate] fetchPending error:", err);
    } finally {
      fetchingRef.current = false;
    }
  }, [user?.id, shouldRun]);

  // Initial fetch on mount / user change.
  useEffect(() => {
    if (!shouldRun) {
      setQueue([]);
      setRejectStep(false);
      return;
    }
    void fetchPending();
  }, [shouldRun, fetchPending]);

  // Refetch on window focus / visibility change (cheap guard against stale data).
  useEffect(() => {
    if (!shouldRun) return;
    const onFocus = () => void fetchPending();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchPending();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [shouldRun, fetchPending]);

  // 60 s polling fallback while feature is enabled.
  useEffect(() => {
    if (!shouldRun) return;
    const id = setInterval(() => void fetchPending(), 60_000);
    return () => clearInterval(id);
  }, [shouldRun, fetchPending]);

  // ── Realtime subscription ────────────────────────────────────────────────

  useEffect(() => {
    if (!shouldRun || !user?.id) return;

    const channelName = `transfer-offer-gate-${user.id}`;
    // Remove any stale channel from a previous render.
    const existing = supabase.getChannels().find(
      (ch) => ch.topic === `realtime:${channelName}`,
    );
    if (existing) supabase.removeChannel(existing);

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "balance_transfer_offers" },
        (payload) => {
          const row = payload.new as BalanceTransferOffer;
          if (row.recipient_id !== user.id) return;
          if (row.status !== "pending") return;
          if (seenIdsRef.current.has(row.id)) return;
          // Refetch to get names attached.
          void fetchPending();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "balance_transfer_offers" },
        (payload) => {
          const row = payload.new as BalanceTransferOffer;
          if (row.recipient_id !== user.id && row.transferrer_id !== user.id) return;
          // Re-sync queue (may remove cancelled/accepted offers from another tab).
          void fetchPending();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [shouldRun, user?.id, fetchPending]);

  // ── Action handlers ───────────────────────────────────────────────────────

  const removeCurrentFromQueue = useCallback(() => {
    setQueue((prev) => prev.slice(1));
    setRejectStep(false);
  }, []);

  const handleAccept = async () => {
    if (!currentOffer) return;
    setLoading(true);
    try {
      await BalanceTransferOfferService.acceptOffer(currentOffer.id, {
        transferrerId: currentOffer.transferrer_id,
        recipientName: currentOffer.recipient_name ?? "Recipient",
        amount: Number(currentOffer.amount),
      });
      toast({
        title: t("offerAccepted", { defaultValue: "Transfer accepted" }),
        description: t("offerAcceptedHint", {
          amount: formatINR(currentOffer.amount),
          defaultValue: `Your balance has been updated by ${formatINR(currentOffer.amount)}.`,
        }),
      });
      void refreshBalance();
      removeCurrentFromQueue();
      // Sync so any remaining pending offers are still fresh.
      void fetchPending();
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("common:error", { defaultValue: "Error" }),
        description:
          err instanceof Error ? err.message : "Failed to accept transfer",
      });
      // Offer may no longer exist — re-sync to find out.
      void fetchPending();
    } finally {
      setLoading(false);
    }
  };

  const handleRejectConfirm = async (reason: string) => {
    if (!currentOffer) return;
    setLoading(true);
    try {
      await BalanceTransferOfferService.rejectOffer(currentOffer.id, reason, {
        transferrerId: currentOffer.transferrer_id,
        recipientName: currentOffer.recipient_name ?? "Recipient",
        amount: Number(currentOffer.amount),
      });
      toast({
        title: t("offerRejected", { defaultValue: "Transfer rejected" }),
        description: t("offerRejectedHint", {
          defaultValue: "The transfer request has been declined.",
        }),
      });
      removeCurrentFromQueue();
      void fetchPending();
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("common:error", { defaultValue: "Error" }),
        description:
          err instanceof Error ? err.message : "Failed to reject transfer",
      });
      void fetchPending();
    } finally {
      setLoading(false);
    }
  };

  const handleReviewLater = () => {
    // Dismiss popup but don't mark anything — user can come back via the page.
    setQueue([]);
    setRejectStep(false);
    navigate("/transfer-offers");
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (!shouldRun || !currentOffer) return null;

  const paymentModeLabel =
    currentOffer.payment_mode === "bank_transfer" ? "Bank transfer" : "Cash";

  return (
    <Dialog
      open={true}
      // Prevent closing by clicking outside — user must act or click Review later.
      onOpenChange={() => {}}
    >
      <DialogContent
        className="max-w-sm sm:max-w-md w-[calc(100vw-2rem)] sm:w-full"
        // Suppress the default close button (X) from shadcn DialogContent so the
        // user cannot dismiss without acting. We render our own "Review later" escape.
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {/* Minimal close button that routes to /transfer-offers */}
        <button
          className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
          onClick={handleReviewLater}
          aria-label="Review later"
          disabled={loading}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Review later</span>
        </button>

        <DialogHeader>
          <div className="flex items-center gap-2 pr-6">
            <Coins className="h-5 w-5 text-amber-600 flex-shrink-0" />
            <DialogTitle>
              {t("promptGate.title", { defaultValue: "Transfer request" })}
              {queue.length > 1 ? (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({queue.length} pending)
                </span>
              ) : null}
            </DialogTitle>
          </div>
          <DialogDescription>
            {t("promptGate.description", {
              defaultValue:
                "Accept this transfer to update your balance. Reject it if the amount or details are incorrect.",
            })}
          </DialogDescription>
        </DialogHeader>

        {rejectStep ? (
          <RejectReasonStep
            offer={currentOffer}
            loading={loading}
            onCancel={() => setRejectStep(false)}
            onConfirm={(reason) => void handleRejectConfirm(reason)}
          />
        ) : (
          <div className="space-y-4 py-1">
            {/* Amount — prominent */}
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-center">
              <p className="text-2xl font-bold text-amber-800">
                {formatINR(currentOffer.amount)}
              </p>
            </div>

            {/* Offer details */}
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("from", { defaultValue: "From" })}
                </dt>
                <dd className="font-medium text-right">
                  {currentOffer.transferrer_name || "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Payment mode</dt>
                <dd className="font-medium text-right">{paymentModeLabel}</dd>
              </div>
              {currentOffer.source_bank_name_snapshot && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Bank</dt>
                  <dd className="font-medium text-right">
                    {currentOffer.source_bank_name_snapshot}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("proposedAt", { defaultValue: "Proposed at" })}
                </dt>
                <dd className="font-medium text-right">
                  {format(new Date(currentOffer.proposed_at), "MMM d, h:mm a")}
                </dd>
              </div>
              {currentOffer.note && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">
                    {t("note", { defaultValue: "Note" })}
                  </dt>
                  <dd className="font-medium text-right break-words max-w-[60%]">
                    {currentOffer.note}
                  </dd>
                </div>
              )}
            </dl>

            {/* Actions */}
            {actionProgress.status !== "idle" && (
              <AsyncOperationProgress
                status={actionProgress.status}
                title={actionProgress.phase}
                showSuccess={actionProgress.status === "success"}
                compact
              />
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="text-destructive border-destructive/40 hover:bg-destructive/5 hover:text-destructive"
                disabled={loading}
                onClick={() => setRejectStep(true)}
              >
                {t("reject", { defaultValue: "Reject" })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground ml-auto"
                disabled={loading}
                onClick={handleReviewLater}
              >
                {t("promptGate.reviewLater", { defaultValue: "Review later" })}
              </Button>
              <Button
                size="sm"
                disabled={loading}
                onClick={() => void handleAccept()}
              >
                {loading
                  ? t("common:saving", { defaultValue: "Saving…" })
                  : t("promptGate.acceptTransfer", {
                      defaultValue: "Accept transfer",
                    })}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
