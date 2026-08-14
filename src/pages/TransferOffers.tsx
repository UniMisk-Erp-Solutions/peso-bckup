import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatINR } from "@/lib/format";
import { format } from "date-fns";
import {
  BalanceTransferOfferService,
  type BalanceTransferOffer,
} from "@/services/BalanceTransferOfferService";
import { TransferOfferActions } from "@/components/TransferOfferActions";
import {
  TransferOfferStatusBadge,
  transferOfferStatusLabel,
} from "@/components/TransferOfferStatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileTransferOffersView } from "@/components/mobile/MobileTransferOffersView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";

function formatOfferDate(value: string | null | undefined) {
  if (!value) return null;
  return format(new Date(value), "MMM d, yyyy h:mm a");
}

export default function TransferOffers() {
  const { t } = useTranslation("transfers");
  const navigate = useNavigate();
  const { user, hasOrganizationFeature } = useAuth();
  const enabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance,
  );

  const [pending, setPending] = useState<BalanceTransferOffer[]>([]);
  const [history, setHistory] = useState<BalanceTransferOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const { isMobile } = useViewportMode();
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress(t("transfers:statusPending"));
    } else if (!loading && wasLoading) {
      completeLoadProgress(t("transfers:statusAccepted"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const load = useCallback(async () => {
    if (!user?.id || !enabled) return;
    setLoading(true);
    try {
      const [pendingRows, historyRows] = await Promise.all([
        BalanceTransferOfferService.fetchPendingForRecipient(user.id),
        BalanceTransferOfferService.fetchHistoryForUser(user.id),
      ]);
      setPending(pendingRows);
      setHistory(historyRows);
    } finally {
      setLoading(false);
    }
  }, [user?.id, enabled]);

  useEffect(() => {
    if (!enabled) {
      navigate("/dashboard", { replace: true });
      return;
    }
    void load();
  }, [enabled, load, navigate]);

  useEffect(() => {
    if (!enabled || !user?.id) return;

    const channel = supabase
      .channel(`transfer-offers-page-${user.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "balance_transfer_offers" },
        () => {
          void load();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, user?.id, load]);

  if (!enabled) return null;

  if (isMobile) {
    return (
      <MobileTransferOffersView
        pending={pending}
        history={history}
        loading={loading}
        onLoad={() => void load()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-muted-foreground mt-1">
          {t("promptGate.pageHint", {
            defaultValue:
              "Pending transfer requests also appear as a popup when you log in or open the app.",
          })}
        </p>
      </div>

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">
            {t("pendingTab")}
            {pending.length > 0 ? ` (${pending.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">{t("historyTab")}</TabsTrigger>
        </TabsList>

        {loadProgress.status !== "idle" && (
          <div className="mb-2">
            <AsyncOperationProgress
              status={loadProgress.status}
              title={loadProgress.phase}
              showSuccess={loadProgress.status === "success"}
              compact={loadProgress.status === "running"}
            />
          </div>
        )}
        <TabsContent value="pending" className="space-y-3 mt-4">
          {loading ? null : pending.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t("noPending")}
              </CardContent>
            </Card>
          ) : (
            pending.map((offer) => (
              <Card key={offer.id} className="border-blue-200">
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-lg">{formatINR(offer.amount)}</CardTitle>
                      <CardDescription>
                        {t("from")} {offer.transferrer_name || "—"} ·{" "}
                        {format(new Date(offer.proposed_at), "MMM d, yyyy h:mm a")}
                      </CardDescription>
                    </div>
                    <TransferOfferStatusBadge
                      status="pending"
                      label={t("statusPending")}
                    />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {offer.note ? (
                    <p className="text-sm text-muted-foreground">
                      {t("note")}: {offer.note}
                    </p>
                  ) : null}
                  <TransferOfferActions offer={offer} onUpdated={() => void load()} />
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-3 mt-4">
          {loading ? null : history.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t("noHistory")}
              </CardContent>
            </Card>
          ) : (
            history.map((offer) => (
              <Card
                key={offer.id}
                className={
                  offer.status === "accepted"
                    ? "border-green-200"
                    : offer.status === "rejected"
                      ? "border-red-200"
                      : offer.status === "cancelled"
                        ? "border-slate-200"
                        : undefined
                }
              >
                <CardContent className="py-4 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <span className="text-lg font-semibold">{formatINR(offer.amount)}</span>
                      <p className="text-sm text-muted-foreground">
                        {offer.recipient_id === user?.id
                          ? `${t("from")} ${offer.transferrer_name}`
                          : `${t("to")} ${offer.recipient_name}`}
                      </p>
                    </div>
                    <TransferOfferStatusBadge
                      status={offer.status}
                      label={transferOfferStatusLabel(offer.status, t)}
                    />
                  </div>
                  <div className="text-sm text-muted-foreground space-y-0.5">
                    <p>
                      <span className="font-medium text-foreground">{t("proposedAt")}:</span>{" "}
                      {formatOfferDate(offer.proposed_at) ?? "—"}
                    </p>
                    {offer.responded_at ? (
                      <p>
                        <span className="font-medium text-foreground">{t("respondedAt")}:</span>{" "}
                        {formatOfferDate(offer.responded_at)}
                      </p>
                    ) : null}
                  </div>
                  {offer.note ? (
                    <p className="text-sm text-muted-foreground">
                      {t("note")}: {offer.note}
                    </p>
                  ) : null}
                  {offer.rejection_reason ? (
                    <p className="text-sm text-destructive">
                      {t("rejectionReason")}: {offer.rejection_reason}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
