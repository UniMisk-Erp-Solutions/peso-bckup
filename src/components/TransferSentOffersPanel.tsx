import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatINR } from "@/lib/format";
import { format } from "date-fns";
import { ListPagination } from "@/components/ListPagination";
import { paginateItems, clampPage } from "@/lib/listPagination";
import {
  BalanceTransferOfferService,
  type BalanceTransferOffer,
} from "@/services/BalanceTransferOfferService";
import {
  TransferOfferStatusBadge,
  transferOfferStatusLabel,
} from "@/components/TransferOfferStatusBadge";
import { useToast } from "@/hooks/use-toast";

function formatOfferDate(value: string | null | undefined) {
  if (!value) return null;
  return format(new Date(value), "MMM d, yyyy h:mm a");
}

export function TransferSentOffersPanel() {
  const { t } = useTranslation("transfers");
  const { user } = useAuth();
  const { toast } = useToast();
  const [offers, setOffers] = useState<BalanceTransferOffer[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [offersPage, setOffersPage] = useState(1);
  const [offersPageSize, setOffersPageSize] = useState(10);
  const clampedOffersPage = useMemo(
    () => clampPage(offersPage, offers.length, offersPageSize),
    [offersPage, offers.length, offersPageSize],
  );
  const pagedOffers = useMemo(
    () => paginateItems(offers, clampedOffersPage, offersPageSize),
    [offers, clampedOffersPage, offersPageSize],
  );

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const rows = await BalanceTransferOfferService.fetchSentByTransferrer(user.id);
      setOffers(rows);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCancel = async (offer: BalanceTransferOffer) => {
    setCancellingId(offer.id);
    try {
      await BalanceTransferOfferService.cancelOffer(offer.id, {
        recipientId: offer.recipient_id,
        transferrerName: offer.transferrer_name || "Sender",
        amount: Number(offer.amount),
      });
      toast({ title: t("offerCancelled") });
      await load();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Error",
        description: e instanceof Error ? e.message : "Failed to cancel",
      });
    } finally {
      setCancellingId(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground py-4">Loading…</p>;
  }

  if (offers.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">{t("noSent")}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {pagedOffers.map((offer) => (
        <Card
          key={offer.id}
          className={
            offer.status === "pending"
              ? "border-amber-200"
              : offer.status === "accepted"
                ? "border-green-200"
                : offer.status === "rejected"
                  ? "border-red-200"
                  : offer.status === "cancelled"
                    ? "border-slate-200"
                    : undefined
          }
        >
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {formatINR(offer.amount)} → {offer.recipient_name}
              </CardTitle>
              <TransferOfferStatusBadge
                status={offer.status}
                label={transferOfferStatusLabel(offer.status, t)}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="text-muted-foreground space-y-0.5">
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
            {offer.rejection_reason ? (
              <p className="text-destructive">
                {t("rejectionReason")}: {offer.rejection_reason}
              </p>
            ) : null}
            {offer.status === "pending" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={cancellingId === offer.id}
                onClick={() => void handleCancel(offer)}
              >
                {t("cancel")}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ))}
      <ListPagination
        page={clampedOffersPage}
        pageSize={offersPageSize}
        totalItems={offers.length}
        onPageChange={setOffersPage}
        onPageSizeChange={setOffersPageSize}
        pageSizeOptions={[10, 25, 50]}
      />
    </div>
  );
}
