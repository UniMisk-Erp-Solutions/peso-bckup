import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle, XCircle } from "lucide-react";
import { formatINR } from "@/lib/format";
import { validateTransferRejectionReason } from "@/lib/balanceTransferOfferValidation";
import {
  BalanceTransferOfferService,
  type BalanceTransferOffer,
} from "@/services/BalanceTransferOfferService";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

export function TransferOfferActions({
  offer,
  onUpdated,
  compact = false,
}: {
  offer: BalanceTransferOffer;
  onUpdated: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("transfers");
  const { toast } = useToast();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const handleAccept = async () => {
    setLoading(true);
    try {
      await BalanceTransferOfferService.acceptOffer(offer.id, {
        transferrerId: offer.transferrer_id,
        recipientName: offer.recipient_name || "Recipient",
        amount: Number(offer.amount),
      });
      toast({
        title: t("offerAccepted"),
        description: t("offerAcceptedHint", { amount: formatINR(offer.amount) }),
      });
      onUpdated();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Error",
        description: e instanceof Error ? e.message : "Failed to accept offer",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    const validation = validateTransferRejectionReason(rejectReason);
    if (!validation.valid) {
      toast({
        variant: "destructive",
        title: "Error",
        description: t("validation.rejectionReasonTooShort"),
      });
      return;
    }
    setLoading(true);
    try {
      await BalanceTransferOfferService.rejectOffer(offer.id, rejectReason, {
        transferrerId: offer.transferrer_id,
        recipientName: offer.recipient_name || "Recipient",
        amount: Number(offer.amount),
      });
      toast({
        title: t("offerRejected"),
        description: t("offerRejectedHint"),
      });
      setRejectOpen(false);
      setRejectReason("");
      onUpdated();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Error",
        description: e instanceof Error ? e.message : "Failed to reject offer",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className={`flex gap-2 ${compact ? "flex-shrink-0" : ""}`}>
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => setRejectOpen(true)}
        >
          <XCircle className="h-4 w-4 mr-1" />
          {t("reject")}
        </Button>
        <Button size="sm" disabled={loading} onClick={() => void handleAccept()}>
          <CheckCircle className="h-4 w-4 mr-1" />
          {t("accept")}
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("rejectTitle")}</DialogTitle>
            <DialogDescription>{t("rejectDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor={`reject-reason-${offer.id}`}>{t("rejectReasonLabel")}</Label>
            <Textarea
              id={`reject-reason-${offer.id}`}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder={t("rejectReasonPlaceholder")}
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={loading} onClick={() => void handleReject()}>
              {t("rejectConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
