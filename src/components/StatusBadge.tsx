import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

type ExpenseStatus =
  | "submitted"
  | "verified"
  | "approved"
  | "rejected"
  | "edited"
  | "level_1_verified"
  | "level_2_verified";

interface StatusBadgeProps {
  status: ExpenseStatus | string;
  className?: string;
  /** When `owner`, status `edited` is shown as Submitted (post–reviewer adjustment). */
  viewerContext?: "owner" | "reviewer";
}

export function StatusBadge({ status, className, viewerContext = "reviewer" }: StatusBadgeProps) {
  const { t } = useTranslation("expenses");
  const displayKey =
    viewerContext === "owner" && status === "edited" ? "submitted" : status;

  const statusConfig: Record<
    string,
    { labelKey: string; variant: "default" | "secondary" | "destructive" | "outline" | "success"; bgColor?: string }
  > = {
    submitted: { labelKey: "status.submitted", variant: "default" as const },
    level_1_verified: {
      labelKey: "status.level1Verified",
      variant: "default" as const,
      bgColor: "bg-sky-100 text-sky-900 border-sky-200",
    },
    level_2_verified: {
      labelKey: "status.level2Verified",
      variant: "default" as const,
      bgColor: "bg-indigo-100 text-indigo-900 border-indigo-200",
    },
    verified: { labelKey: "status.verified", variant: "default" as const, bgColor: "bg-green-100 text-green-800 border-green-200" },
    approved: { labelKey: "status.approved", variant: "default" as const, bgColor: "bg-green-100 text-green-800 border-green-200" },
    rejected: { labelKey: "status.rejected", variant: "destructive" as const, bgColor: "bg-red-100 text-red-800 border-red-200" },
    edited: { labelKey: "status.edited", variant: "secondary" as const, bgColor: "bg-amber-50 text-amber-900 border-amber-200" },
  };

  const config =
    statusConfig[displayKey] || { labelKey: "", variant: "secondary" as const };

  const label = config.labelKey ? t(config.labelKey) : String(status);

  const title =
    status === "level_2_verified"
      ? "Approved by executive — awaiting final manager approval"
      : viewerContext === "owner" && status === "edited"
        ? t("status.editedOwnerHint")
        : undefined;

  return (
    <Badge variant={config.variant} className={cn(config.bgColor, className)} title={title}>
      {label}
    </Badge>
  );
}
