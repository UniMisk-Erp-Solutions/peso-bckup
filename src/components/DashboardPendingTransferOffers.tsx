import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/format";
import { format } from "date-fns";
import {
  BalanceTransferOfferService,
  type BalanceTransferOffer,
} from "@/services/BalanceTransferOfferService";
import { TransferOfferActions } from "@/components/TransferOfferActions";
import { supabase } from "@/integrations/supabase/client";

export function DashboardPendingTransferOffers() {
  const { t } = useTranslation("transfers");
  const navigate = useNavigate();
  const { user, hasOrganizationFeature } = useAuth();
  const enabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.transfer_recipient_acceptance,
  );
  const [offers, setOffers] = useState<BalanceTransferOffer[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!enabled || !user?.id) return;
    setLoading(true);
    try {
      const rows = await BalanceTransferOfferService.fetchPendingForRecipient(user.id);
      setOffers(rows.slice(0, 5));
    } finally {
      setLoading(false);
    }
  }, [enabled, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!enabled || !user?.id) return;
    const channel = supabase
      .channel(`dashboard-transfer-offers-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "balance_transfer_offers",
          filter: `recipient_id=eq.${user.id}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, user?.id, load]);

  if (!enabled) return null;

  return (
    <Card>
      <CardHeader className="px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg sm:text-xl">{t("dashboardTitle")}</CardTitle>
            <CardDescription className="text-sm">{t("dashboardDescription")}</CardDescription>
          </div>
          <Button variant="link" className="shrink-0" onClick={() => navigate("/transfer-offers")}>
            {t("viewAll")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : offers.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">{t("noPending")}</p>
        ) : (
          offers.map((offer) => (
            <Card key={offer.id} className="border-blue-200">
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-blue-700">{formatINR(offer.amount)}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {t("from")} {offer.transferrer_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(offer.proposed_at), "MMM d, h:mm a")}
                    </p>
                  </div>
                  <TransferOfferActions
                    offer={offer}
                    onUpdated={() => void load()}
                    compact
                  />
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </CardContent>
    </Card>
  );
}
