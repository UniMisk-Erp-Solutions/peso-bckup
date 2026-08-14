import { format } from "date-fns";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatINR } from "@/lib/format";
import { TransferOfferActions } from "@/components/TransferOfferActions";
import {
  TransferOfferStatusBadge,
  transferOfferStatusLabel,
} from "@/components/TransferOfferStatusBadge";
import type { BalanceTransferOffer } from "@/services/BalanceTransferOfferService";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslation } from "react-i18next";

function formatOfferDate(value: string | null | undefined) {
  if (!value) return null;
  return format(new Date(value), "MMM d, yyyy h:mm a");
}

interface Props {
  pending: BalanceTransferOffer[];
  history: BalanceTransferOffer[];
  loading: boolean;
  onLoad: () => void;
}

export function MobileTransferOffersView({ pending, history, loading, onLoad }: Props) {
  const { t } = useTranslation("transfers");
  const { user } = useAuth();

  return (
    <div className="px-4 py-4 space-y-4">
      <p className="text-xs text-muted-foreground">
        {t("promptGate.pageHint", {
          defaultValue:
            "Pending transfer requests also appear as a popup when you log in or open the app.",
        })}
      </p>
      <Tabs defaultValue="pending">
        <TabsList className="w-full">
          <TabsTrigger value="pending" className="flex-1">
            {t("pendingTab", { defaultValue: "Pending" })}
            {pending.length > 0 ? ` (${pending.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-1">
            {t("historyTab", { defaultValue: "History" })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="space-y-3 mt-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="h-5 w-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            </div>
          ) : pending.length === 0 ? (
            <Card>
              <CardContent
                className="py-8 text-center text-sm text-muted-foreground"
                data-testid="transfer-offers-pending-empty"
              >
                {t("noPending", { defaultValue: "No pending offers" })}
              </CardContent>
            </Card>
          ) : (
            pending.map((offer) => (
              <Card key={offer.id} className="border-blue-200" data-testid="transfer-offer-card">
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-lg">{formatINR(offer.amount)}</CardTitle>
                      <CardDescription>
                        {t("from", { defaultValue: "From" })} {offer.transferrer_name || "—"} ·{" "}
                        {format(new Date(offer.proposed_at), "MMM d, yyyy h:mm a")}
                      </CardDescription>
                    </div>
                    <TransferOfferStatusBadge
                      status="pending"
                      label={t("statusPending", { defaultValue: "Pending" })}
                    />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {offer.note && (
                    <p className="text-sm text-muted-foreground">
                      {t("note", { defaultValue: "Note" })}: {offer.note}
                    </p>
                  )}
                  <TransferOfferActions offer={offer} onUpdated={() => onLoad()} />
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-3 mt-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="h-5 w-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            </div>
          ) : history.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {t("noHistory", { defaultValue: "No history" })}
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
                    <div className="space-y-0.5">
                      <span className="text-lg font-semibold">{formatINR(offer.amount)}</span>
                      <p className="text-sm text-muted-foreground">
                        {offer.recipient_id === user?.id
                          ? `${t("from", { defaultValue: "From" })} ${offer.transferrer_name}`
                          : `${t("to", { defaultValue: "To" })} ${offer.recipient_name}`}
                      </p>
                    </div>
                    <TransferOfferStatusBadge
                      status={offer.status}
                      label={transferOfferStatusLabel(offer.status, t)}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p>
                      <span className="font-medium text-foreground">
                        {t("proposedAt", { defaultValue: "Proposed" })}:
                      </span>{" "}
                      {formatOfferDate(offer.proposed_at) ?? "—"}
                    </p>
                    {offer.responded_at && (
                      <p>
                        <span className="font-medium text-foreground">
                          {t("respondedAt", { defaultValue: "Responded" })}:
                        </span>{" "}
                        {formatOfferDate(offer.responded_at)}
                      </p>
                    )}
                  </div>
                  {offer.note && (
                    <p className="text-xs text-muted-foreground">
                      {t("note", { defaultValue: "Note" })}: {offer.note}
                    </p>
                  )}
                  {offer.rejection_reason && (
                    <p className="text-xs text-destructive">
                      {t("rejectionReason", { defaultValue: "Rejection reason" })}:{" "}
                      {offer.rejection_reason}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
