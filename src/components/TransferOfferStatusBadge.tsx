import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type TransferOfferStatus = "pending" | "accepted" | "rejected" | "cancelled" | string;

const STATUS_STYLES: Record<string, string> = {
  pending:
    "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200",
  accepted:
    "border-green-300 bg-green-50 text-green-800 dark:border-green-700 dark:bg-green-950 dark:text-green-200",
  rejected:
    "border-red-300 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200",
  cancelled:
    "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300",
};

export function transferOfferStatusLabel(
  status: string,
  t: (key: string) => string,
): string {
  switch (status) {
    case "pending":
      return t("statusPending");
    case "accepted":
      return t("statusAccepted");
    case "rejected":
      return t("statusRejected");
    case "cancelled":
      return t("statusCancelled");
    default:
      return status;
  }
}

export function TransferOfferStatusBadge({
  status,
  label,
  className,
}: {
  status: TransferOfferStatus;
  label: string;
  className?: string;
}) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.cancelled;

  return (
    <Badge variant="outline" className={cn("shrink-0 font-medium", style, className)}>
      {label}
    </Badge>
  );
}
